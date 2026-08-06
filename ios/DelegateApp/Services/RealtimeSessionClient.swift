import AVFoundation
import Foundation
import WebRTC

/// Connects directly to OpenAI's Realtime API over WebRTC, using a short-lived
/// client secret minted by our backend. See docs/technical-decisions.md,
/// ADR-005, and backend/src/lib/openaiRealtime.ts for the architecture and why
/// this is the OpenAI-recommended pattern for a native client.
///
/// **Requires the `WebRTC` Swift package** (github.com/stasel/WebRTC — a
/// prebuilt distribution of Google's libwebrtc for iOS/macOS). Apple ships no
/// first-party WebRTC framework, so this is an unavoidable dependency, not a
/// choice. Add it in Xcode: File → Add Package Dependencies →
/// `https://github.com/stasel/WebRTC`.
///
/// **This file has never been compiled or run.** The container this was
/// written in has no Swift toolchain (see ios/README.md). The REST handshake
/// (mint secret → POST offer SDP → apply answer SDP) is written against
/// OpenAI's documented flow and should be close; the WebRTC library API
/// surface (delegate method signatures, exact class/enum names) is written
/// from general iOS WebRTC usage patterns and is the most likely thing to
/// need small fixes on first real build.
///
/// **Known open risk, not solved here: echo cancellation on speakerphone.**
/// The AI's own voice comes out the phone's speaker; the same phone's mic
/// then has to pick up the other, real person's voice without also picking up
/// the AI talking to itself. WebRTC's built-in AEC (enabled below via
/// `.voiceChatSpeaker` mode) is the standard mitigation, but multiple
/// developers report it does not fully solve this on real devices in
/// speakerphone-like scenarios — the model can hear and interrupt itself.
/// This needs real-device testing before relying on it; there is no way to
/// verify it from source code alone.
@MainActor
final class RealtimeSessionClient: NSObject, ObservableObject {
    enum State: Equatable {
        case idle
        case connecting
        case live
        case ended
        case failed(String)
    }

    @Published private(set) var state: State = .idle

    private let backend: BackendClient
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        let encoder = RTCDefaultVideoEncoderFactory()
        let decoder = RTCDefaultVideoDecoderFactory()
        return RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    }()

    init(backend: BackendClient) {
        self.backend = backend
    }

    /// Fetches a session from our backend, connects to OpenAI over WebRTC,
    /// and starts the live conversation. Throws on any failure along the way;
    /// `state` also reflects the outcome for UI binding.
    func start(brief: Brief) async throws {
        state = .connecting

        do {
            let session = try await backend.startRealtimeSession(brief: brief)
            try configureAudioSession()
            try await connect(using: session)
            state = .live
        } catch {
            state = .failed(String(describing: error))
            throw error
        }
    }

    func stop() {
        dataChannel?.close()
        peerConnection?.close()
        dataChannel = nil
        peerConnection = nil
        audioTrack = nil
        state = .ended

        try? AVAudioSession.sharedInstance().setActive(false)
    }

    /// Back to `.idle` so the brief form reappears. Safe to call whether the
    /// previous session ended normally or failed — `stop()` already tore down
    /// any live connection, and this just clears the terminal state on top.
    func reset() {
        if peerConnection != nil { stop() }
        state = .idle
    }

    // MARK: - Audio session

    /// `.voiceChatSpeaker` is the mode that gets iOS's own echo cancellation
    /// engaged for a speaker-out/mic-in same-device conversation — the
    /// closest first-party mitigation for the echo risk documented above.
    /// WebRTC's own audio processing module is expected to layer on top of
    /// this; whether the combination is sufficient in practice is exactly the
    /// open question that needs a real device to answer.
    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChatSpeaker,
            options: [.defaultToSpeaker, .allowBluetooth]
        )
        try session.setActive(true)
    }

    // MARK: - WebRTC handshake

    private func connect(using session: RealtimeSessionInfo) async throws {
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        // No STUN/TURN servers: OpenAI's endpoint is a direct SDP exchange
        // over HTTPS, not a peer needing NAT traversal to a third party.
        config.iceServers = []

        let constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: nil
        )

        guard
            let pc = Self.factory.peerConnection(
                with: config,
                constraints: constraints,
                delegate: self
            )
        else {
            throw RealtimeSessionError.peerConnectionCreationFailed
        }
        peerConnection = pc

        // Mic track, added before the offer so it's included in the SDP.
        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "googEchoCancellation": "true",
                "googNoiseSuppression": "true",
                "googAutoGainControl": "true",
            ],
            optionalConstraints: nil
        )
        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "audio0")
        pc.add(track, streamIds: ["stream0"])
        audioTrack = track

        // Event channel, also created before the offer for the same reason.
        let dataChannelConfig = RTCDataChannelConfiguration()
        dataChannel = pc.dataChannel(forLabel: "oai-events", configuration: dataChannelConfig)
        dataChannel?.delegate = self

        let offerConstraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true"],
            optionalConstraints: nil
        )
        let offer = try await Self.createOffer(pc, constraints: offerConstraints)
        try await Self.setLocalDescription(pc, offer)

        let answerSDP = try await postOffer(offer.sdp, clientSecret: session.clientSecret)
        let answer = RTCSessionDescription(type: .answer, sdp: answerSDP)
        try await Self.setRemoteDescription(pc, answer)
    }

    // MARK: - Completion-handler bridging
    //
    // RTCPeerConnection's offer/setLocalDescription/setRemoteDescription are
    // completion-handler APIs on every WebRTC iOS distribution this was
    // written against docs for — that's the well-established, long-standing
    // surface, unlike a native async overload which may or may not exist on
    // whatever package version actually gets added in Xcode. Bridging by
    // hand here is the safer bet than assuming `try await pc.offer(...)`
    // compiles.

    private static func createOffer(
        _ pc: RTCPeerConnection,
        constraints: RTCMediaConstraints
    ) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { continuation in
            pc.offer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: RealtimeSessionError.peerConnectionCreationFailed)
                }
            }
        }
    }

    private static func setLocalDescription(
        _ pc: RTCPeerConnection,
        _ description: RTCSessionDescription
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setLocalDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private static func setRemoteDescription(
        _ pc: RTCPeerConnection,
        _ description: RTCSessionDescription
    ) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pc.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    /// The one leg of this flow that isn't peer-to-peer WebRTC signaling: a
    /// plain HTTPS POST of the SDP offer, answered with the SDP answer as
    /// plain text. Verified against
    /// https://developers.openai.com/api/docs/guides/realtime-webrtc on
    /// 2026-08-06 — re-check if this fails with an unexpected status.
    private func postOffer(_ offerSDP: String, clientSecret: String) async throws -> String {
        var request = URLRequest(url: URL(string: "https://api.openai.com/v1/realtime/calls")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = offerSDP.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw RealtimeSessionError.sdpExchangeFailed(status: status)
        }
        guard let sdp = String(data: data, encoding: .utf8) else {
            throw RealtimeSessionError.sdpExchangeFailed(status: -1)
        }
        return sdp
    }
}

enum RealtimeSessionError: Error {
    case peerConnectionCreationFailed
    case sdpExchangeFailed(status: Int)
}

// MARK: - RTCPeerConnectionDelegate

extension RealtimeSessionClient: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        // If this ever settles on .failed or .disconnected, the UI should
        // reflect it — currently unwired. See ios/README.md.
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        // No trickle ICE needed for OpenAI's single-shot SDP exchange.
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

// MARK: - RTCDataChannelDelegate

extension RealtimeSessionClient: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    /// Realtime session events (response.done, error, etc.) arrive here as
    /// JSON. Not parsed yet — logging only. A real UI likely wants at least
    /// `error` and `response.done` surfaced; see ios/README.md.
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let text = String(data: buffer.data, encoding: .utf8) else { return }
        print("oai-events: \(text)")
    }
}
