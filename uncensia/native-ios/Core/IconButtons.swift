import SwiftUI

// Named vector assets use the same Lucide paths as the web client.
extension Button where Label == SwiftUI.Label<Text, Image> {
    init(_ title: String, image: String, action: @escaping () -> Void) {
        self.init(action: action) { SwiftUI.Label(title, image: image) }
    }
}

extension View {
    /// Text scrolled under the navigation bar must not collide with the title:
    /// iOS 26 draws a hard scroll edge, earlier releases a solid bar.
    @ViewBuilder func readableUnderNavigationBar() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            toolbarBackground(.visible, for: .navigationBar)
        }
    }
}
