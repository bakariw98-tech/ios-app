import SwiftUI

/// The primary screen for in-person mode (ADR-005): type a quick brief, the
/// AI starts talking immediately, live, out loud.
///
/// No consent step, no disclosure line, no merge instructions — unlike
/// phone-call mode (CallView), there's no separate private phase and no third
/// party being brought onto a line they didn't expect. The user is standing
/// right there; see docs/technical-decisions.md, ADR-005, for why that
/// removes the need for the phone-mode compliance machinery entirely for
/// *this* mode.
struct BriefView: View {
    let client: BackendClient

    @State private var situationText: String = ""
    @State private var userFirstName: String = ""
    // @StateObject, not nested inside another ObservableObject: SwiftUI only
    // re-renders on changes to an object it observes directly. Wrapping this
    // inside a view model whose own @Published property held the client
    // would mean `session.state` changing (connecting -> live) never
    // triggers a re-render, since the outer object's objectWillChange only
    // fires when the *reference* is reassigned, not when the referenced
    // object mutates internally.
    @StateObject private var session: RealtimeSessionClient

    init(client: BackendClient) {
        self.client = client
        _session = StateObject(wrappedValue: RealtimeSessionClient(backend: client))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    header

                    switch session.state {
                    case .idle, .failed:
                        briefEntry
                    case .connecting:
                        ProgressView("Connecting…")
                            .padding(.top, 40)
                    case .live:
                        liveIndicator
                    case .ended:
                        endedView
                    }

                    if case .failed(let message) = session.state {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 32)
            }
            .navigationTitle("Say it")
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Text("What do you need said?")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)

            Text("Type it, and I'll say it out loud right now.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private var briefEntry: some View {
        VStack(spacing: 16) {
            TextField("Your name (optional)", text: $userFirstName)
                .textFieldStyle(.roundedBorder)

            TextEditor(text: $situationText)
                .frame(minHeight: 120)
                .padding(8)
                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
                .overlay(alignment: .topLeading) {
                    if situationText.isEmpty {
                        Text("e.g. \"I'm at McDonald's, I want a McDouble no pickles and a water.\"")
                            .foregroundStyle(.secondary)
                            .padding(14)
                            .allowsHitTesting(false)
                    }
                }

            Button {
                Task { await start() }
            } label: {
                Label("Start Talking", systemImage: "waveform")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(situationText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private var liveIndicator: some View {
        VStack(spacing: 20) {
            Image(systemName: "waveform")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
                .symbolEffect(.variableColor.iterative, options: .repeating)

            Text("Live")
                .font(.headline)

            Text("Hold the phone toward the conversation. I'll handle the back-and-forth — jump in any time.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(role: .destructive) {
                session.stop()
            } label: {
                Label("End", systemImage: "stop.fill")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.bordered)
        }
        .padding(.top, 20)
    }

    private var endedView: some View {
        VStack(spacing: 16) {
            Text("Done")
                .font(.headline)

            Button("Say something else") {
                situationText = ""
                session.reset()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.top, 20)
    }

    private func start() async {
        let brief = Brief(
            situation: situationText.trimmingCharacters(in: .whitespacesAndNewlines),
            userFirstName: userFirstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : userFirstName
        )
        try? await session.start(brief: brief)
    }
}
