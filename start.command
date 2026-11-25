#!/bin/bash
# macOS / Linux: 더블클릭(또는 터미널에서 실행)하면 게임이 열려요. 창을 닫으면 종료.
cd "$(dirname "$0")"
PORT=8080
( sleep 1; (open "http://localhost:$PORT/index.html" 2>/dev/null || xdg-open "http://localhost:$PORT/index.html") ) &
python3 -m http.server $PORT
