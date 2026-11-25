APEX FOOTBALL — 실행 방법
================================

[웹]       GitHub Pages 주소로 접속
[VS Code]  Live Server 확장으로 index.html 열기
[Python]   이 폴더에서  python3 -m http.server 8080  실행 → http://localhost:8080 접속

※ 파일을 나눈 버전이라 index.html을 직접 더블클릭하면 브라우저 보안 때문에 실행되지 않아요.
※ 저장 데이터(계정 · 구단)는 브라우저 주소마다 따로 저장돼요 (웹 주소와 localhost는 서로 다른 데이터).

파일 구성
---------
index.html    화면 구조(HTML)
style.css     디자인(CSS)
main.js       게임 코드(JavaScript)
players.json  선수 데이터 190명 (8구단 × 20명 + 이적시장 30명)
photos/       선수 사진 폴더 (photos/README.txt 참고)
tools/format_players.py   players.json 정리 스크립트

players.json 고치는 법
---------------------
players 배열의 순서가 선수 번호(tid)예요. 순서를 바꾸거나 중간 선수를 지우면
이미 뽑은 카드가 다른 선수로 바뀌니, 고칠 땐 값만 바꾸고 새 선수는 맨 뒤에 추가하세요.
  name 이름 · nation 국적 · club 구단(blue/red/white/black/green/orange/yellow/cyan, 이적시장은 null)
  grp 구단 내 자리(xi 선발 · subs 교체 · res 후보 · fa 이적시장) · pos 포지션 · num 등번호
  age 나이 · foot 주발(left/right) · height 키(cm) · weight 몸무게(kg)
  fo 능력치 34개 (오버롤은 포지션 주요 능력치 평균으로 자동 계산)
  photo 사진 파일 이름 (photos 폴더 기준, 빈 칸 ""이면 사진 없음 — photos/README.txt 참고)

players.json 모양 (정리 규칙)
----------------------------
선수 1명 = 기본 정보 1줄 + "fo" 능력치 5줄(게임 능력치 화면 5열과 같은 묶음 7·7·7·8·5개).
손으로 고친 뒤 모양이 흐트러지면  python3 tools/format_players.py  를 실행하면 다시 이 모양으로 정리돼요
(값은 그대로 두고 줄바꿈 · 공백만 바꿈).
