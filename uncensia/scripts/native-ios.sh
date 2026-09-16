#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
ios_dir="$repo_dir/native-ios"
action="${1:-prepare}"
case "$action" in
  prepare) (cd "$ios_dir" && xcodegen generate) ;;
  build) (cd "$ios_dir" && xcodegen generate && xcodebuild -project Uncensia.xcodeproj -scheme Uncensia -destination 'generic/platform=iOS Simulator' build) ;;
  test)
    # Scheme env vars expand these from build settings, so UNCENSIA_* fixtures
    # set on this command line reach the simulator test runner.
    settings=()
    while IFS='=' read -r name value; do
      [[ -n $name ]] && settings+=("$name=$value")
    done < <(env | grep -E '^UNCENSIA_[A-Z_]+=')
    (cd "$ios_dir" && xcodegen generate && xcodebuild -project Uncensia.xcodeproj -scheme Uncensia -destination "${UNCENSIA_IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}" "${settings[@]}" test) ;;
  *) echo "usage: $0 prepare|build|test" >&2; exit 2 ;;
esac
