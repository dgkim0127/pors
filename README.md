# 피어싱 계산

태블릿에서 쓰는 피어싱 계산 앱입니다. 거래처별 할인율, VAT 별도 계산, 품목/카테고리/거래처 관리, 판매 내역, A4 반쪽 2매 영수증 출력을 지원합니다.

## 현재 실행 방식

개발 중에는 브라우저에서 바로 확인할 수 있고, 최종 사용은 Capacitor로 APK를 만들어 Android 태블릿에 설치하는 방향입니다.

관리자키 기본값은 `0000`입니다.

파일을 직접 열 때는 `index.html`을 더블클릭해도 화면이 뜨도록 상대 경로를 사용합니다. 이 방식은 React 스크립트를 인터넷에서 받아오므로 인터넷 연결이 필요합니다. 설치형 PWA 기능과 일부 브라우저 보안 기능은 개발 서버 또는 APK에서 더 안정적으로 동작합니다.

## APK 만들기

자세한 순서는 [APK_BUILD.md](./APK_BUILD.md)를 보세요.

요약:

```powershell
npm install
npm run android:add
npm run android:open
```

Android Studio가 열리면 `Build > Build Bundle(s) / APK(s) > Build APK(s)`로 APK를 만듭니다.

## Supabase

`supabase/schema.sql`을 Supabase SQL editor에 적용한 뒤 `app-config.js`와 `public/app-config.js`에 URL, anon key, 관리자키를 넣습니다.

Supabase 설정이 비어 있으면 앱은 로컬 데모 저장소로 작동합니다.

보안/운영 체크리스트는 [SECURITY.md](./SECURITY.md)를 확인하세요.

## 주요 파일

- `src/app.js`: 계산, 관리, 내역, 출력 화면
- `src/calculations.js`: 할인/VAT 계산 로직
- `src/data.js`: 로컬 저장소와 Supabase REST 연결 준비
- `src/styles.css`: 태블릿 UI와 A4 출력 스타일
- `supabase/schema.sql`: DB 테이블 초안
- `capacitor.config.json`: APK 포장 설정
