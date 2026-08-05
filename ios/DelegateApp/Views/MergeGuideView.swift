import SwiftUI

/// Teaches the merge step.
///
/// This is the highest-risk moment in the product. The app cannot perform the
/// merge (there's no CallKit API for it) and cannot detect that it happened —
/// see docs/technical-decisions.md, ADR-001. All we can do is explain it well
/// enough that someone mid-difficult-phone-call can follow it.
///
/// Hence: three steps, native control names in bold, and an explicit note that
/// the assistant handles the introduction — so the user isn't left wondering
/// whether they're supposed to explain the AI themselves.
struct MergeGuideView: View {
    let instruction: String

    private let steps: [(symbol: String, title: String, detail: String)] = [
        (
            "plus.circle.fill",
            "Tap **Add Call**",
            "I'll still be here — you won't lose me."
        ),
        (
            "phone.fill",
            "Dial them",
            "Wait until they pick up."
        ),
        (
            "arrow.triangle.merge",
            "Tap **Merge Calls**",
            "Then just tell me they're on, and I'll introduce myself."
        ),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("When you're ready to bring them on")
                .font(.headline)

            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: step.symbol)
                        .font(.title3)
                        .foregroundStyle(.tint)
                        .frame(width: 28)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(.init(step.title))
                            .font(.subheadline.weight(.medium))
                        Text(step.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Step \(index + 1). \(step.title.replacingOccurrences(of: "**", with: "")). \(step.detail)")
            }

            Divider()

            Label {
                Text("I always tell them I'm an AI speaking for you, and ask if they're okay to continue, before I say anything else.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 20))
    }
}
