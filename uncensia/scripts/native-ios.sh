#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
ios_dir="$repo_dir/native-ios"
action="${1:-prepare}"
case "$action" in
  prepare) (cd "$ios_dir" && xcodegen generate) ;;
  build) (cd "$ios_dir" && xcodegen generate && xcodebuild -project Uncensia.xcodeproj -scheme Uncensia -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build) ;;
  test) (cd "$ios_dir" && xcodegen generate && xcodebuild -project Uncensia.xcodeproj -scheme Uncensia -destination "${UNCENSIA_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}" test) ;;
  *) echo "usage: $0 prepare|build|test" >&2; exit 2 ;;
esac
