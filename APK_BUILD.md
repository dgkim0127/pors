# APK 빌드 안내

이 프로젝트는 Capacitor로 Android APK를 만들 수 있게 준비되어 있습니다.

## 1. PC에 설치할 것

- Node.js LTS
- Android Studio
- Android SDK Platform
- Android SDK Build-Tools

Android Studio 설치 후 `SDK Manager`에서 최신 Android SDK와 Build-Tools를 설치합니다.

## 2. 첫 Android 프로젝트 생성

PowerShell에서 프로젝트 폴더로 이동한 뒤 실행합니다.

```powershell
npm install
npm run android:add
```

이 명령은 `dist` 빌드를 만들고 `android/` 프로젝트를 생성합니다.

## 3. 앱 열기

```powershell
npm run android:open
```

Android Studio가 열리면 `Build > Build Bundle(s) / APK(s) > Build APK(s)`를 선택합니다.

## 4. 이후 수정 후 APK 갱신

앱 코드를 수정한 뒤에는 아래 명령으로 Android 프로젝트에 반영합니다.

```powershell
npm run android:sync
```

그 다음 Android Studio에서 APK를 다시 빌드합니다.

## 5. Supabase 설정

APK에 클라우드 DB를 붙일 때는 `app-config.js`와 `public/app-config.js` 값을 채웁니다.

```js
window.PIERCE_SUPABASE_URL = "https://your-project.supabase.co";
window.PIERCE_SUPABASE_ANON_KEY = "your-anon-key";
window.PIERCE_ADMIN_KEY = "0000";
```

운영 전에는 `supabase/schema.sql`의 임시 RLS 정책을 매장 단위 관리자키 검증 방식으로 강화해야 합니다.

## 6. 태블릿 설치

완성된 APK를 태블릿으로 옮긴 뒤 설치합니다. Android 설정에서 출처를 알 수 없는 앱 설치 허용이 필요할 수 있습니다.
