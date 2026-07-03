# html-androidtest — CH340 WebUSB 드라이버 실험

## 이 폴더의 목적

`tools/forHtml`의 웹 페이지를 **Android Chrome**에서도 동작시키려는 실험 폴더.

두 가지 접근을 시도함:
1. **1차 시도**: `google/web-serial-polyfill` (CDC-ACM 표준 폴리필) 적용 → **실패**. 이 프로젝트 보드는 CH340이고, 이 폴리필은 CDC-ACM만 지원함.
2. **2차 시도 (현재 상태)**: **CH340 벤더 프로토콜을 자체 JS로 이식**한 `ch340-driver.js` 추가. Web Serial API의 SerialPort 인터페이스를 CH340 규약으로 구현.

## 폴더 구성

- `index.html` — 상단 "시리얼 API" 드롭다운: 자동/네이티브/CH340/CDC-ACM 폴리필
- `style.css` — API 선택 바 스타일
- `app.js` — `serialApi` 변수로 백엔드 전환. 자동 모드에서 모바일이면 CH340 우선.
- `serial-polyfill.js` — google/web-serial-polyfill 1.0.15 (참고용, CDC-ACM만)
- **`ch340-driver.js` (핵심)** — CH340 벤더 프로토콜 자체 구현. `window.ch340Serial` 노출.
  - 참고 소스: `mik3y/usb-serial-for-android`의 `Ch34xSerialDriver.java`, Linux `drivers/usb/serial/ch341.c`
  - 대상: CH340 (0x1a86:0x7523), CH341 (0x1a86:0x5523), CH340K (0x1a86:0x7522)
  - 지원: baud rate 자유 설정, 데이터 비트/스톱 비트/패리티, DTR/RTS 신호 (Line Control 비트 세팅 포함)

## CH340 프로토콜 요약 (드라이버 이해용)

CH340은 표준 CDC-ACM이 아니라 **벤더 컨트롤 전송**으로 설정을 받음:

| 명령 | 방향 | 용도 |
|---|---|---|
| `0x5F` | IN | 버전 읽기 (핑) |
| `0x95` | IN | 레지스터 읽기 |
| `0x9A` | OUT | 레지스터 쓰기 (baud, LCR 설정) |
| `0xA1` | OUT | 시리얼 초기화 |
| `0xA4` | OUT | MODEM_OUT (DTR/RTS, bit-inverted) |

Baud rate는 clock `1532620800 / baudRate` 공식으로 divisor/LCR 값을 계산해 레지스터 `0x1312`, `0x0F2C`에 씀.
LCR은 `LCR_ENABLE_RX(0x80) | LCR_ENABLE_TX(0x40) | CS8(0x03)` = 0xC3 (8-N-1 기준).
데이터 송수신은 벌크 엔드포인트 (표준 USB) 사용.

## 테스트 방법

### PC에서 (로직 검증만, 실제 동작은 어려움)
1. Chrome/Edge에서 `index.html` 열기
2. 자동 → "네이티브 (자동 · PC)"로 뜸. 기존 forHtml처럼 동작해야 정상.
3. 수동으로 "CH340 (WebUSB)" 선택 시 → Windows에서는 WCH 드라이버가 CH340을 점유 중이라 **WebUSB 열기 실패 가능성 높음**. Linux에서 `modprobe -r ch341` 하면 열림.

### Android에서 (본 목적)
1. `usb-serial-for-android` 앱이 실행 중이면 종료 (USB 장치 점유 방지)
2. Chrome에서 `index.html` 열기 (로컬 서버 or `file://`)
3. 자동 → "CH340 (자동 · 모바일)"로 뜸
4. "포트 선택…" 클릭 → USB 장치 승인 팝업 → CH340 승인
5. "연결" 클릭
6. **개발자 도구 열어서 `[CH340]` 로그 확인**:
   - 각 컨트롤 전송의 request/value/index/응답이 콘솔에 찍힘
   - `stall` 에러가 나오면 초기화 시퀀스 조정 필요
   - `ver` 응답이 안 오면 baud rate 계산이 잘못됐거나 line control 문제

## 알려진 미해결/불확실 사항

- **초기화 시퀀스**의 특정 값(`0x501F 0xD90A`, `0x0706` 등)은 usb-serial-for-android의 매직 상수. CH340 리비전에 따라 미묘하게 다를 수 있음.
- Baud rate 공식 `1532620800 / baudRate`은 usb-serial-for-android 기반. Linux ch341.c는 다른 접근을 씀. 값이 안 맞으면 여기부터 의심.
- Android Chrome이 특정 CH340 USB 장치의 WebUSB 접근을 아예 차단할 가능성 (블랙리스트/드라이버 점유 등) — 이 경우 코드 수정으로는 못 뚫음.

## 권장 사용 도구 (검증 완료된 것)

| 플랫폼 | 도구 |
|---|---|
| PC (Windows/Mac/Linux) | `tools/forHtml/` 또는 `tools/forHtmlDist/LDDisplay-Control.html` |
| Android | `tools/forAndroid/` (usb-serial-for-android로 CH340 완전 지원) |
| iOS | 지원 불가 |

이 폴더는 **웹으로 안드로이드 지원을 통일하는 것이 가치가 있는지 검증하는 실험**임. 성공하면 forAndroid를 대체 가능, 실패해도 forAndroid를 계속 쓰면 됨.
