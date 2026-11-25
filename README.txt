APEX FOOTBALL — 실행 방법
================================

[Windows]  start.bat 더블클릭 → 브라우저에서 게임이 열려요.
           검은 창(서버)은 게임하는 동안 켜 두고, 끝나면 닫으면 돼요.
[macOS]    start.command 더블클릭 (처음엔 우클릭 → 열기)
[VS Code]  Live Server 확장으로 index.html 열기

※ 파일을 나눈 버전이라 index.html을 직접 더블클릭하면 브라우저 보안 때문에 실행되지 않아요.
※ 저장 데이터(계정 · 구단)는 브라우저 주소(http://localhost:8080)마다 따로 저장돼요.
   포트 8080이 이미 쓰이고 있으면 8081~8090을 쓰는데, 그러면 저장 데이터가 따로 보여요.

파일 구성
---------
index.html    화면 구조(HTML)
style.css     디자인(CSS)
main.js       게임 코드(JavaScript)
players.json  선수 데이터 190명 (8구단 × 20명 + 이적시장 30명)
start.bat / server.ps1 / start.command   실행용

players.json 고치는 법
---------------------
players 배열의 순서가 선수 번호(tid)예요. 순서를 바꾸거나 중간 선수를 지우면
이미 뽑은 카드가 다른 선수로 바뀌니, 고칠 땐 값만 바꾸고 새 선수는 맨 뒤에 추가하세요.
  name 이름 · nation 국적 · club 구단(blue/red/white/black/green/orange/yellow/cyan, 이적시장은 null)
  grp 구단 내 자리(xi 선발 · subs 교체 · res 후보 · fa 이적시장) · pos 포지션 · num 등번호
  age 나이 · foot 주발(left/right) · height 키(cm) · weight 몸무게(kg)
  fo 능력치 34개 (오버롤은 포지션 주요 능력치 평균으로 자동 계산)
