import Foundation

/// Talks to the delegation backend.
///
/// Note there is no `placeCall`. The app displays a number and the user dials
/// it — see docs/compliance.md (N4). `startSession` fetches display data only.
actor BackendClient {
    private let baseURL: URL
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func startSession() async throws -> SessionStart {
        try await get("session/start")
    }

    /// Mints an OpenAI Realtime client secret for the in-person mode. See
    /// backend/src/routes/realtime.ts. Throws `BackendError.status(503)` if
    /// the backend has no `OPENAI_API_KEY` configured.
    func startRealtimeSession(brief: Brief) async throws -> RealtimeSessionInfo {
        var request = URLRequest(url: baseURL.appendingPathComponent("realtime/session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(brief)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.badResponse
        }
        guard http.statusCode == 200 else {
            throw BackendError.status(http.statusCode)
        }
        return try decoder.decode(RealtimeSessionInfo.self, from: data)
    }

    func status(callId: String) async throws -> CallStatus {
        try await get("session/\(callId)/status")
    }

    func transcript(callId: String) async throws -> [TranscriptLine] {
        struct Response: Codable { let transcript: [TranscriptLine] }
        let response: Response = try await get("session/\(callId)/transcript")
        return response.transcript
    }

    /// Returns nil while post-call analysis is still running (backend sends 202).
    func summary(callId: String) async throws -> CallSummary? {
        let (data, response) = try await URLSession.shared.data(
            from: baseURL.appendingPathComponent("session/\(callId)/summary")
        )
        guard let http = response as? HTTPURLResponse else {
            throw BackendError.badResponse
        }
        if http.statusCode == 202 { return nil }
        guard http.statusCode == 200 else {
            throw BackendError.status(http.statusCode)
        }
        return try decoder.decode(CallSummary.self, from: data)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await URLSession.shared.data(
            from: baseURL.appendingPathComponent(path)
        )
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw BackendError.status((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try decoder.decode(T.self, from: data)
    }
}

enum BackendError: Error {
    case badResponse
    case status(Int)
}
