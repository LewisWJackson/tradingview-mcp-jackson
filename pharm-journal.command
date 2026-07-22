#!/bin/bash
# Pharm Journal — double-click to see how your setups actually performed.
# Prints the report and opens the HTML dashboard.
cd "$(dirname "$0")" || exit 1

echo ""
node pharm-journal.js --html
echo ""

if [ -f pharm-journal.html ]; then
  open pharm-journal.html
fi

read -n 1 -s -r -p "  Press any key to close..."
