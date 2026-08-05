import SwiftUI

/// The chat box from the brief — a live view of what's being said.
///
/// Read-only. Typing here would be a second channel into a voice conversation,
/// which raises the question of whether the AI should relay typed instructions
/// mid-call while a recipient is listening. Not answered yet, so not built yet.
struct TranscriptView: View {
    let callId: String
    let client: BackendClient

    @State private var lines: [TranscriptLine] = []

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(lines) { line in
                        bubble(line).id(line.id)
                    }
                }
                .padding(20)
            }
            .onChange(of: lines.count) {
                withAnimation { proxy.scrollTo(lines.last?.id, anchor: .bottom) }
            }
        }
        .navigationTitle("Live")
        .navigationBarTitleDisplayMode(.inline)
        .task { await poll() }
    }

    private func bubble(_ line: TranscriptLine) -> some View {
        HStack {
            if !line.isAssistant { Spacer(minLength: 40) }

            Text(line.text)
                .font(.subheadline)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    line.isAssistant ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.tint),
                    in: RoundedRectangle(cornerRadius: 16)
                )
                .foregroundStyle(line.isAssistant ? .primary : .white)

            if line.isAssistant { Spacer(minLength: 40) }
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            if let fetched = try? await client.transcript(callId: callId) {
                lines = fetched
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
