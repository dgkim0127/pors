# POS 판매 데이터 계약

이 문서는 `pors`가 저장하고 웹이 읽기 또는 분석할 수 있는 판매 레코드의 공통 의미를 정의한다.
POS 앱이 판매 원본의 소유자이며 웹에서는 이 값을 직접 수정하지 않는다.

## 차감

차감은 토탈 원가에서 가장 먼저 빼는 별도 정산 항목이다.
거래처 할인과 구간 할인은 차감 후 남은 금액을 기준으로 다시 계산하고, VAT는 최종 공급가를 기준으로 계산한다.
`taxIncluded`는 차감액에 세금이 포함되었는지 확인하기 위한 기록이며 계산 순서나 VAT 계산식을 바꾸지 않는다.

```js
sale: {
  deduction: {
    amount: number,       // 0 이상, 차감 전 총액 이하의 원화 정수
    taxIncluded: boolean  // true: 세금 포함, false: 세금 미포함
  },
  totals: {
    subtotal: number,
    discount: number,
    supply: number,
    vat: number,
    beforeDeductionSupply: number,
    beforeDeductionTotal: number,
    deduction: number,
    deductionTaxIncluded: boolean,
    total: number
  }
}
```

계산 관계:

```text
deduction = min(requestedDeduction, subtotal)
discountBase = subtotal - deduction
discount = recalculateDiscount(discountBase)
supply = subtotal - deduction - discount
vat = vatEnabled ? round(supply * 0.1) : 0
total = supply + vat
```

기존 판매처럼 `deduction` 필드가 없으면 `amount: 0`, `taxIncluded: false`로 해석한다.
공동구매 판매에는 거래처별 차감 배분 규칙이 정의되기 전까지 차감을 적용하지 않는다.

## 판매 내역 보관과 조회

Firebase의 `sales` 컬렉션이 판매 원본이며 기간이나 건수로 임의 삭제하거나 잘라서 저장하지 않는다.
`전체` 기간은 `sales` 컬렉션에 남아 있는 모든 판매를 `createdAt` 내림차순으로 조회한다.

기기 로컬 저장소와 레거시 통합 상태 문서에는 용량 보호를 위해 최근 500건만 캐시할 수 있다.
이 제한은 오프라인 복구용 캐시에만 적용하며 Firebase 판매 원본이나 온라인 판매 내역 화면을 삭제하거나 제한하는 규칙이 아니다.

판매 원본 삭제는 관리자 삭제 기능을 통해서만 수행하고 삭제 기록을 별도로 남긴다.

## 작성자 삭제

작성자 마스터에서 작성자를 삭제해도 기존 판매의 `writerName` 문자열은 유지한다.
삭제는 이후 작성자 선택 목록에서만 제거되며 과거 판매와 영수증은 변경하지 않는다.
