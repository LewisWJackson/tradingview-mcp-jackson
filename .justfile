# Invisible default - list all tasks
_default:
    @just --list

osname := os()

script := if osname == "linux" { "./scripts/launch_tv_debug_linux.sh" } else if osname == "macos" { "./scripts/launch_tv_debug_mac.sh" } else { "scripts\\launch_tv_debug.bat" }

# Launch TradingView (auto-detects Linux/Mac/Windows)
on:
    @{{script}}

# Check CDP connection status
status:
    npm run tv -- status
