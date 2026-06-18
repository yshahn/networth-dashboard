# Net Worth Dashboard — Plaid 백엔드 설정 가이드

## 0. 사전 준비
- Node.js 설치되어 있어야 함 (이미 있으실 거예요)
- Firebase 계정 (Google 계정으로 로그인)
- Plaid 계정 (이미 가입하셨죠 — Developers > Keys 에서 client_id / secret 확인)

---

## 1. 이 폴더를 본인 PC로 다운로드 후 압축 해제
다운받은 `networth-plaid-backend` 폴더를 원하는 위치에 두세요. (예: `C:\projects\networth-plaid-backend`)

## 2. CMD에서 폴더로 이동
```
cd C:\projects\networth-plaid-backend
```

## 3. Firebase CLI 설치 (한 번만)
```
npm install -g firebase-tools
```

## 4. Firebase 로그인
```
firebase login
```
브라우저가 열리면 본인 Google 계정으로 로그인하세요.

## 5. 새 Firebase 프로젝트 생성
Firebase 콘솔(https://console.firebase.google.com)에서 직접 "프로젝트 추가"로 만드셔도 되고, CLI로도 가능합니다:
```
firebase projects:create networth-yong
```
(이름은 전세계에서 고유해야 해서 다른 이름이면 에러날 수 있어요. `networth-yong-2026` 같은 식으로 바꿔보세요.)

## 6. 이 폴더를 그 프로젝트와 연결
```
firebase use --add
```
방금 만든 프로젝트를 선택하고, alias는 `default`로 입력하세요.

## 7. Functions 의존성 설치
```
cd functions
npm install
cd ..
```

## 8. Blaze 요금제로 업그레이드 (필수)
Cloud Functions를 쓰려면 Firebase 프로젝트가 **Blaze (종량제)** 요금제여야 합니다.
- Firebase 콘솔 → 프로젝트 선택 → 왼쪽 아래 "업그레이드" 클릭 → Blaze 선택
- 개인 프로젝트 규모로는 월 비용이 거의 안 나옵니다 (보통 $0~몇 달러 수준). 신용카드 등록만 필요해요.

## 9. Plaid 키를 Secret으로 등록
CMD에서 하나씩 실행하면, 값 입력하라는 프롬프트가 뜹니다:
```
firebase functions:secrets:set PLAID_CLIENT_ID
firebase functions:secrets:set PLAID_SECRET
firebase functions:secrets:set PLAID_ENV
```
- `PLAID_CLIENT_ID` → Plaid 대시보드의 client_id 붙여넣기
- `PLAID_SECRET` → 처음엔 **Sandbox secret** 붙여넣기 (나중에 실계좌 연동할 때 Production secret으로 교체)
- `PLAID_ENV` → `sandbox` 입력 (나중에 `production`으로 변경)

## 10. Firestore 활성화
Firebase 콘솔 → Build → Firestore Database → "데이터베이스 만들기" → 프로덕션 모드 → 리전은 `us-central` 추천

## 11. 배포
```
firebase deploy --only functions,firestore:rules
```
처음 배포는 몇 분 걸릴 수 있어요. 끝나면 함수 3개(`createLinkToken`, `exchangePublicToken`, `getBalances`)와 스케줄 함수(`dailySnapshot`)가 클라우드에 올라갑니다.

## 12. Firebase 웹 앱 등록 (프론트엔드 연결용)
Firebase 콘솔 → 프로젝트 설정 → "앱 추가" → 웹 앱 선택 → 이름 아무거나 입력
나오는 `firebaseConfig` 객체를 복사해두세요. 다음 단계에서 대시보드 프론트엔드에 붙일 거예요.

## 13. Authentication 활성화
Firebase 콘솔 → Build → Authentication → Sign-in method → "익명" 또는 "이메일/비밀번호" 활성화
(개인용 앱이니 간단하게 이메일/비밀번호 하나만 켜두시면 충분합니다)

---

## 완료 후
여기까지 되면 백엔드(서버) 준비는 끝입니다. 다음 작업은:
1. 프론트엔드(대시보드)에 Firebase Auth 로그인 추가
2. "은행/증권 계좌 연결" 버튼 → Plaid Link 띄우기 → `createLinkToken` / `exchangePublicToken` 호출
3. 대시보드가 `getBalances`를 호출해서 수동 입력 대신 자동으로 잔고 표시

13번까지 끝나시면 알려주세요. 그 다음 프론트엔드 연동 코드를 만들어드릴게요.
