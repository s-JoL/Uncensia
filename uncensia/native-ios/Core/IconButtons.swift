import SwiftUI

// Named vector assets use the same Lucide paths as the web client.
extension Button where Label == SwiftUI.Label<Text, Image> {
    init(_ title: String, image: String, action: @escaping () -> Void) {
        self.init(action: action) { SwiftUI.Label(title, image: image) }
    }
}
