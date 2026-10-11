# side-panel

> A right-hand pane for Claude Code: your questions on top, the files and pages they produced below.

Claude Code 플러그인(모드)입니다. 터미널 오른쪽에 **화면 1/3 너비의 창**을 띄워, 위쪽엔 내가 한 질문들을, 아래쪽엔 그 질문이 만들어낸 결과물(파일·페이지)을 보여줍니다. 각 대화는 짧게 요약되고, 같이 돌고 있는 다른 Claude 세션의 상태도 함께 표시됩니다.

## 기능

- **질문 / 결과 분리**: 위에는 질문, 아래에는 그 결과로 만들어지거나 바뀐 파일·페이지
- **대화 요약**: 각 주고받음을 3~6줄로 압축(질문 언어 그대로)
- **다른 세션 추적**: `claude agents --json`을 주기적으로 읽어 다른 세션의 진행/완료 상태 표시
- **파일 미리보기**: 패널 안에서 파일 앞부분 미리보기, 전체는 메모장으로 열기(Windows)

## 설치

Claude Code 안에서 아래 두 줄을 실행하세요.

```
/plugin marketplace add caesar00723-max/side-panel
/plugin install side-panel@side-panel
```

설치 후 패널 열기:

```
/panel
```

144열보다 넓은 터미널에서는 자동으로 뜨고, 좁을 땐 기다렸다가 `/panel`로 직접 열 수 있습니다.

## 요구 사항

- **Claude Code** (플러그인/모드 지원 버전)
- **Windows** 권장 — "전체 파일 열기"가 메모장(`notepad.exe`)을 사용합니다. 그 외 기능(패널 표시, 요약, 세션 추적, 미리보기)은 플랫폼 영향이 적습니다.
- 다른 세션 추적에는 `claude` CLI가 PATH에 있어야 합니다.

## 라이선스

[MIT](LICENSE) © caesar00723-max
