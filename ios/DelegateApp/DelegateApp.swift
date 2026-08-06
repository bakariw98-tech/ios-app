import SwiftUI

@main
struct DelegateApp: App {
    private let client: BackendClient

    init() {
        // Set BACKEND_URL in the scheme's environment for local development.
        let raw = ProcessInfo.processInfo.environment["BACKEND_URL"]
            ?? "http://localhost:3000"
        guard let url = URL(string: raw) else {
            fatalError("Invalid BACKEND_URL: \(raw)")
        }
        client = BackendClient(baseURL: url)
    }

    var body: some Scene {
        WindowGroup {
            // In-person mode (BriefView) is primary — see
            // docs/technical-decisions.md, ADR-005. Phone-call mode (CallView)
            // is paused, not removed, and stays reachable as a second tab
            // rather than hidden entirely.
            TabView {
                BriefView(client: client)
                    .tabItem { Label("In Person", systemImage: "waveform") }

                CallView(client: client)
                    .tabItem { Label("Phone Call", systemImage: "phone") }
            }
        }
    }
}
