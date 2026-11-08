# KAMIS Price Information MCP Server

KAMIS 농수축산물 유통정보 Open-API를 MCP 도구로 제공하는 Node.js Streamable HTTP 서버입니다.

## 제공 도구

- `kamis_monthly_prices`: 월별 도·소매 가격 조회 (기본 중품·도매, kg 환산)
- `kamis_period_wholesale_prices`: 기간별 품목 도매가격 조회 (최대 1년)
- `kamis_daily_category_prices`: 최근 일자 부류별 도·소매 가격 조회
- `kamis_item_codes`: 내장 코드표의 품목·품종 코드 조회
- `kamis_find_item`: 품목명·품종명 검색
- `kamis_item_kinds`: 품목별 품종·단위·등급 확인
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

## 품목·품종 자동 매핑

업로드된 KAMIS MCPB 1.3.0 코드표를 참고해 다음 품목의 품목·품종 매핑을 내장했습니다.

| 입력 | KAMIS 품목코드 | 품종코드 | 품종 |
|---|---:|---:|---|
| 양파 | 245 | 00 | 양파 |
| 파 또는 대파 | 246 | 00 | 대파 |
| 쪽파 | 246 | 02 | 쪽파 |
| 양배추 | 212 | 00 | 양배추 |

품목과 품종을 따로 입력하지 않고 대파라고 요청해도 파(246)+대파(00)로 조회합니다. 파만 입력해도 기본 품종을 대파(00)로 선택합니다. 쪽파를 조회하려면 쪽파 또는 품종코드 02를 명시하세요.

월별 조회의 등급 기본값은 중품이며, 도매(중도매) 가격을 기본으로 합니다. 전국 평균은 지역 코드를 생략하고, kg 환산은 기본 적용합니다.