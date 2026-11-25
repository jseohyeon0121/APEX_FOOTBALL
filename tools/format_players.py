# players.json 정리 스크립트 — 값은 그대로 두고 줄바꿈 · 공백만 정해진 모양으로 맞춘다.
# 사용법 (APEX_FOOTBALL 폴더에서):  python3 tools/format_players.py
# 모양: 선수 1명 = 기본 정보 1줄 + 능력치(fo) 5줄 (게임 능력치 화면 5열 FO_COLS와 같은 묶음 7·7·7·8·5)
# "photo"(사진 파일 이름, photos 폴더 기준)가 없는 선수에는 빈 칸 ""을 넣는다.
import json, os, sys

PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'players.json')
BASE_KEYS = ['tid', 'name', 'nation', 'club', 'grp', 'pos', 'num', 'age', 'foot', 'height', 'weight', 'photo']
FO_ROWS = [
    ['sprint', 'accel', 'finishing', 'shotPower', 'longShots', 'positioning', 'volleys'],
    ['penalty', 'shortPass', 'vision', 'crossing', 'longPass', 'freekick', 'curve'],
    ['dribbling', 'ballControl', 'agility', 'balance', 'reactions', 'marking', 'standTackle'],
    ['interceptions', 'heading', 'slideTackle', 'strength', 'stamina', 'aggression', 'jump', 'composure'],
    ['gkDiving', 'gkHandling', 'gkKick', 'gkReflex', 'gkPos'],
]
FO_ALL = [k for row in FO_ROWS for k in row]

def j(v):
    return json.dumps(v, ensure_ascii=False)

def pairs(obj, keys):
    return ', '.join(f'{j(k)}: {j(obj[k])}' for k in keys)

def main():
    with open(PATH, encoding='utf-8-sig') as f:
        data = json.load(f)
    players = data['players']
    out = ['{']
    for k, v in data.items():
        if k != 'players':
            out.append(f'  {j(k)}: {j(v)},')
    out.append('  "players": [')
    for i, p in enumerate(players):
        p.setdefault('photo', '')
        base = BASE_KEYS + [k for k in p if k not in BASE_KEYS and k != 'fo']
        fo = p.get('fo', {})
        extra_fo = [k for k in fo if k not in FO_ALL]
        if extra_fo:
            sys.exit(f'알 수 없는 능력치 {extra_fo} (tid {i}) — FO_ROWS에 추가하세요')
        rows = [[k for k in row if k in fo] for row in FO_ROWS]
        rows = [r for r in rows if r]
        out.append('    {' + pairs(p, [k for k in base if k in p]) + ',')
        out.append('     "fo": {')
        for n, r in enumerate(rows):
            out.append('       ' + pairs(fo, r) + (',' if n < len(rows) - 1 else ''))
        out.append('     }}' + (',' if i < len(players) - 1 else ''))
    out.append('  ]')
    out.append('}')
    with open(PATH, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(out) + '\n')
    print(f'players.json 정리 완료: 선수 {len(players)}명')

if __name__ == '__main__':
    main()
