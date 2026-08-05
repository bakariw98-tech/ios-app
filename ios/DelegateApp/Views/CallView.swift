import SwiftUI

/// The main screen: a visible phone number and a call button.
///
/// The user taps to dial. We hand the number to the system dialler via `tel:` —
/// the call is placed by the person, from their device, exactly as if they'd
/// typed it. Nothing here initiates a call on anyone's behalf.
struct CallView: View {
    @StateObject private var model: CallViewModel

    init(client: BackendClient) {
        _model = StateObject(wrappedValue: CallViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    header

                    if let session = model.session {
                        dialCard(session)
                        MergeGuideView(instruction: session.instructions.merge)
                    } else if let error = model.error {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    } else {
                        ProgressView().padding(.top, 40)
                    }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 32)
            }
            .navigationTitle("Say it")
            .task { await model.load() }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Text("Something hard to say?")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)

            Text("Call in and talk it through. When you're ready, bring them on and I'll say it for you.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
    }

    private func dialCard(_ session: SessionStart) -> some View {
        VStack(spacing: 18) {
            Text(session.phoneNumber.formattedPhoneNumber)
                .font(.system(.title, design: .rounded).weight(.medium))
                .monospacedDigit()
                .textSelection(.enabled)

            Button {
                model.dial(session.phoneNumber)
            } label: {
                Label("Call", systemImage: "phone.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Text(session.instructions.before)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 20))
    }
}

@MainActor
final class CallViewModel: ObservableObject {
    @Published var session: SessionStart?
    @Published var error: String?

    private let client: BackendClient

    init(client: BackendClient) {
        self.client = client
    }

    func load() async {
        do {
            session = try await client.startSession()
        } catch {
            self.error = "Couldn't reach the service. Check your connection and try again."
        }
    }

    /// Opens the system dialler. The user still has to confirm the call.
    func dial(_ number: String) {
        let digits = number.filter { $0.isNumber || $0 == "+" }
        guard let url = URL(string: "tel://\(digits)") else { return }
        UIApplication.shared.open(url)
    }
}

private extension String {
    /// +15551234567 -> +1 (555) 123-4567. Returns self unchanged if it isn't a
    /// NANP number, rather than mangling an international one.
    var formattedPhoneNumber: String {
        let digits = Array(filter(\.isNumber))
        guard digits.count == 11, digits.first == "1" else { return self }

        let area = String(digits[1..<4])
        let exchange = String(digits[4..<7])
        let line = String(digits[7..<11])
        return "+1 (\(area)) \(exchange)-\(line)"
    }
}
