# KAMIS Price Information MCP Server

KAMIS 농수축산물 유통정보 Open-API를 MCP 도구로 제공하는 Node.js Streamable HTTP 서버입니다.

## 제공 도구

- `kamis_monthly_prices`: 월별 도·소매 가격 조회 (kg 환산 옵션 포함)
- `kamis_period_wholesale_prices`: 기간별 품목 도매가격 조회 (최대 1년)
- `kamis_daily_category_prices`: 최근 일자 부류별 도·소매 가격 조회
- `kamis_credentials_status`: 서버 인증정보 설정 여부 확인 (비밀값 미노출)

## Render 배포

1. Render에서 **New → Blueprint**를 선택하고 이 저장소를 연결합니다.
2. `render.yaml` 설정을 확인하고 배포합니다.
3. Render 서비스의 **Environment**에 다음 값을 입력합니다.
   - `KAMIS_CERT_ID`: KAMIS Open-API 인증 ID
   - `KAMIS_CERT_KEY`: KAMIS Open-API 인증 Key
4. 배포 완료 후 `https://서비스주소/health`가 `{"status":"ok"}`를 반환하는지 확인합니다.
5. MCP 연결 주소는 `https://서비스주소/mcp`입니다.

인증정보는 코드나 Git 저장소에 넣지 말고 Render 환경변수에만 입력하세요.

## 로컬 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
cp .env.example .env
# .env 파일에 KAMIS_CERT_ID와 KAMIS_CERT_KEY 입력
npm start
```

## API 참고

- KAMIS 월별 도·소매 가격정보: `monthlySalesList`
- KAMIS 기간별 품목 도매가격: `periodWholesaleProductList`
- KAMIS 일별 부류별 도·소매 가격: `dailyPriceByCategoryList`

KAMIS API는 유효한 인증정보가 필요합니다. 품목·품종·등급 코드는 KAMIS가 제공하는 최신 코드표를 기준으로 입력해야 합니다.
