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
            CallView(client: client)
        }
    }
}
