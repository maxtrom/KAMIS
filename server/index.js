import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "64kb", strict: true }));

const API_URL = "https://www.kamis.or.kr/service/price/xml.do";

function credentials() {
  const certId = process.env.KAMIS_CERT_ID;
  const certKey = process.env.KAMIS_CERT_KEY;
  if (!certId || !certKey) {
    throw new Error("KAMIS 인증정보가 설정되지 않았습니다. Render 환경변수 KAMIS_CERT_ID와 KAMIS_CERT_KEY를 입력하세요.");
  }
  return { certId, certKey };
}

function sanitizeKamisData(value) {
  const { certId, certKey } = credentials();
  const secretStrings = [certId, certKey].filter(Boolean);
  const walk = (input, key = "") => {
    if (/^condition$/i.test(key) || /cert.?key|cert.?id|api.?key|secret|authorization/i.test(key) || /^p_(key|id)$/i.test(key)) return undefined;
    if (Array.isArray(input)) return input.map((v) => walk(v)).filter((v) => v !== undefined);
    if (input && typeof input === "object") {
      const out = {};
      for (const [k, v] of Object.entries(input)) {
        const cleaned = walk(v, k);
        if (cleaned !== undefined) out[k] = cleaned;
      }
      return out;
    }
    if (typeof input === "string") {
      return secretStrings.reduce((s, secret) => s.split(secret).join("[REDACTED]"), input);
    }
    return input;
  };
  return walk(value);
}

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, "").replace(/[·ㆍ]/g, "").toLowerCase();
}

/*
 * Official KAMIS item/kind mapping extracted from the supplied MCPB 1.3.0
 * bundled code table (server/data/codes.json).
 * KAMIS item code and kind code are separate dimensions:
 * 245=양파, 246=파(00=대파, 02=쪽파), 212=양배추.
 */
const KAMIS_CROPS = {
  "양파": { item_code: "245", item_name: "양파", kind_code: "00", kind_name: "양파", category_code: "200" },
  "햇양파": { item_code: "245", item_name: "양파", kind_code: "02", kind_name: "햇양파", category_code: "200" },
  "파": { item_code: "246", item_name: "파", kind_code: "00", kind_name: "대파", category_code: "200" },
  "대파": { item_code: "246", item_name: "파", kind_code: "00", kind_name: "대파", category_code: "200" },
  "쪽파": { item_code: "246", item_name: "파", kind_code: "02", kind_name: "쪽파", category_code: "200" },
  "양배추": { item_code: "212", item_name: "양배추", kind_code: "00", kind_name: "양배추", category_code: "200" }
};
const KAMIS_ITEMS_BY_CODE = {
  "212": { item_name: "양배추", category_code: "200", kinds: [{ kind_code: "00", kind_name: "양배추", wholesale_unit: "8kg", wholesale_grades: ["04","05"], retail_unit: "1포기", retail_grades: ["04","05"] }] },
  "245": { item_name: "양파", category_code: "200", kinds: [
    { kind_code: "00", kind_name: "양파", wholesale_unit: "15kg", wholesale_grades: ["04","05"], retail_unit: "1kg", retail_grades: ["04","05"] },
    { kind_code: "02", kind_name: "햇양파", wholesale_unit: "15kg", wholesale_grades: ["04","05"], retail_unit: "1kg", retail_grades: ["04","05"] },
    { kind_code: "10", kind_name: "수입", wholesale_unit: "20kg", wholesale_grades: [], retail_unit: "1kg", retail_grades: ["05"] }
  ] },
  "246": { item_name: "파", category_code: "200", kinds: [
    { kind_code: "00", kind_name: "대파", wholesale_unit: "1kg", wholesale_grades: ["04","05"], retail_unit: "1kg", retail_grades: ["04","05"] },
    { kind_code: "02", kind_name: "쪽파", wholesale_unit: "1kg", wholesale_grades: ["04","05"], retail_unit: "1kg", retail_grades: ["04","05"] }
  ] }
};
function resolveProductRank(input) {
  const value = normalizeName(input ?? "중품");
  const map = { "상품": "04", "중품": "05", "하품": "06", "1": "04", "2": "05", "3": "06", "04": "04", "05": "05", "06": "06" };
  if (!map[value]) throw new Error(`도매 등급 '${input}'을(를) 인식하지 못했습니다. 상품/중품/하품을 사용하세요.`);
  return map[value];
}
function resolveGradeRank(input) {
  const value = normalizeName(input ?? "중품");
  const map = { "상품": "1", "중품": "2", "하품": "3", "1": "1", "2": "2", "3": "3" };
  if (!map[value]) throw new Error(`등급 '${input}'을(를) 인식하지 못했습니다. 상품/중품/하품 또는 1/2/3을 사용하세요.`);
  return map[value];
}
function resolveCrop(input, explicitKind, categoryCode = "200") {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("품목명 또는 KAMIS 품목코드를 지정하세요.");
  let item = KAMIS_CROPS[normalizeName(raw)];
  if (!item && KAMIS_ITEMS_BY_CODE[raw]) {
    const parent = KAMIS_ITEMS_BY_CODE[raw];
    // 파는 품종이 생략되면 기본 품종을 대파(00)로 선택합니다.
    const preferred = parent.kinds.find(k => normalizeName(k.kind_name) === "대파")
      ?? parent.kinds[0];
    item = { item_code: raw, item_name: parent.item_name, kind_code: preferred?.kind_code, kind_name: preferred?.kind_name, category_code: parent.category_code };
  }
  if (!item && /^\d+$/.test(raw)) {
    throw new Error(`품목코드 '${raw}'는 제공된 MCPB 코드표의 지원 품목에 없습니다. kamis_find_item 또는 공식 KAMIS 코드표로 확인하세요.`);
  }
  if (!item) throw new Error(`품목 '${raw}'은 제공된 MCPB 코드표에서 찾지 못했습니다. 현재 내장 매핑: 양파, 햇양파, 파, 대파, 쪽파, 양배추`);
  const parent = KAMIS_ITEMS_BY_CODE[item.item_code];
  let kindCode = item.kind_code;
  let kindName = item.kind_name;
  if (explicitKind) {
    const kindRaw = String(explicitKind).trim();
    const kind = parent?.kinds.find(k => k.kind_code === kindRaw || normalizeName(k.kind_name) === normalizeName(kindRaw));
    if (!kind) throw new Error(`${item.item_name}의 품종 '${kindRaw}'을(를) 찾지 못했습니다. 가능한 품종: ${(parent?.kinds ?? []).map(k => k.kind_name + "(" + k.kind_code + ")").join(", ")}`);
    kindCode = kind.kind_code;
    kindName = kind.kind_name;
  }
  if (normalizeName(raw) === "파" && !explicitKind) {
    kindCode = "00";
    kindName = "대파";
  }
  if (!kindCode) throw new Error(`${item.item_name}의 품종을 결정할 수 없습니다.`);
  return { ...item, kind_code: kindCode, kind_name: kindName, category_code: categoryCode || item.category_code };
}

async function kamisRequest(action, params = {}) {
  const { certId, certKey } = credentials();
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  url.searchParams.set("p_cert_id", certId);
  url.searchParams.set("p_cert_key", certKey);
  url.searchParams.set("p_returntype", "json");

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const timeout = action.startsWith("period") ? 60000 : 25000;
  let data;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "kamis-render-mcp/1.1" },
        signal: AbortSignal.timeout(timeout)
      });
      if (!response.ok) {
        const error = new Error(`KAMIS API HTTP 오류: ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      data = await response.json();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt > 0 || error.name === "TimeoutError" || error.retryable === false) break;
      if (error.message?.startsWith("KAMIS API HTTP") && !error.retryable) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (lastError) {
    if (lastError.name === "TimeoutError") throw new Error("KAMIS 응답 시간 초과: 조회 조건이나 기간을 줄여 다시 시도하세요.");
    throw lastError;
  }
  const resultCode = data?.condition?.result_code ?? data?.result_code ?? data?.error_code;
  if (resultCode && !["000", "001"].includes(String(resultCode))) {
    const message = data?.condition?.result_msg ?? data?.condition?.message ?? "KAMIS API 요청 오류";
    throw new Error(`KAMIS 오류 ${resultCode}: ${message}`);
  }
  return sanitizeKamisData(data);
}

function makeServer() {
  const server = new McpServer({ name: "kamis-price-info", version: "1.0.0" });

  server.registerTool(
    "kamis_monthly_prices",
    {
      title: "KAMIS 월별 도소매 가격 조회",
      description: "MCPB 1.3.0 내장 KAMIS 품목·품종 코드표를 사용합니다. 품목명만 입력하면 품목과 품종을 함께 결정합니다. 특히 '파' 또는 '대파'는 품목 파(246)+품종 대파(00), '쪽파'는 파(246)+품종 쪽파(02)로 조회합니다. 중도매 도매=02, 소매=01. 등급은 상품=1, 중품=2, 하품=3. kg 환산 기본 Y.",
      inputSchema: {
        year: z.string().regex(/^\d{4}$/).describe("조회 연도 예: 2026"),
        period: z.string().default("1").describe("조회 기간(년), 기본 1"),
        category_code: z.string().default("200").describe("부류 코드"),
        item_code: z.string().optional().describe("품목 코드 또는 품목명. crop_name 대신 사용 가능"),
        crop_name: z.string().optional().describe("품목 또는 품종명(예: 양파, 파, 대파, 쪽파, 양배추)"),
        kind_code: z.string().optional().describe("품종 코드 또는 이름. 생략 시 내장 코드표 기본 품종 사용"),
        grade_rank: z.string().default("2").describe("등급: 1 상품, 2 중품, 3 하품. 기본 중품"),
        county_code: z.string().optional().describe("지역 코드. 미입력 시 전국 평균"),
        product_cls_code: z.enum(["01", "02"]).default("02").describe("01 소매, 02 도매(중도매)"),
        convert_kg_yn: z.enum(["Y", "N"]).default("Y").describe("kg 단위 환산 여부")
      }
    },
    async (args) => {
      const requested = args.crop_name || args.item_code;
      const resolved = resolveCrop(requested, args.kind_code, args.category_code);
      const data = await kamisRequest("monthlySalesList", {
        p_yyyy: args.year,
        p_period: args.period,
        p_itemcategorycode: resolved.category_code,
        p_itemcode: resolved.item_code,
        p_kindcode: resolved.kind_code,
        p_graderank: resolveGradeRank(args.grade_rank),
        p_countycode: args.county_code,
        p_convert_kg_yn: args.convert_kg_yn
      });
      if (Array.isArray(data.price)) {
        data.price = data.price.filter((p) => String(p.productclscode) === args.product_cls_code);
      }
      const notes = [`품목 매핑: ${resolved.item_name}(${resolved.item_code}) / 품종 ${resolved.kind_name}(${resolved.kind_code}) / ${args.product_cls_code === "02" ? "도매·중도매" : "소매"} / ${resolveGradeRank(args.grade_rank) === "2" ? "중품" : resolveGradeRank(args.grade_rank) === "1" ? "상품" : "하품"}`];
      if (!Array.isArray(data.price) || data.price.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ message: "해당 조건의 가격자료가 없습니다.", requested: { year: args.year, item: requested, item_code: resolved.item_code, kind_code: resolved.kind_code, grade_rank: args.grade_rank, product_cls_code: args.product_cls_code }, response: sanitizeKamisData(data) }, null, 2) }] };
      }
      return { content: [{ type: "text", text: notes.join("\n") + "\n" + JSON.stringify(sanitizeKamisData(data), null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_item_codes",
    {
      title: "KAMIS 내장 품목코드 목록",
      description: "제공된 MCPB 1.3.0 코드표에서 양파·파/대파·쪽파·양배추의 품목 및 품종 코드를 조회합니다. KAMIS API 호출 없이 반환합니다.",
      inputSchema: { crop_name: z.string().optional() }
    },
    async ({ crop_name }) => {
      const rows = Object.entries(KAMIS_CROPS)
        .filter(([name]) => !crop_name || normalizeName(name).includes(normalizeName(crop_name)) || normalizeName(crop_name).includes(normalizeName(name)))
        .map(([name, v]) => ({ query_name: name, ...v }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_period_wholesale_prices",
    {
      title: "KAMIS 기간별 도매가격 조회",
      description: "기간별 도매(중도매) 가격을 조회합니다. 품목명만 입력하면 내장 코드표로 품목·품종을 자동 결정합니다. '파'/'대파'는 파(246)+대파(00), '쪽파'는 파(246)+쪽파(02)입니다. 등급 기본값은 중품, 지역 기본값은 서울입니다.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        region_code: z.string().optional().describe("도매 지역 코드: 1101 서울, 2100 부산, 2200 대구, 2401 광주, 2501 대전. 미입력 시 서울"),
        item_code: z.string().optional().describe("KAMIS 품목코드 또는 품목명"),
        crop_name: z.string().optional().describe("품목 또는 품종명(양파, 파, 대파, 쪽파, 양배추)"),
        kind_code: z.string().optional().describe("품종 코드 또는 이름"),
        grade_rank: z.string().default("중품").describe("상품/중품/하품 또는 1/2/3")
      }
    },
    async (args) => {
      const resolved = resolveCrop(args.crop_name || args.item_code, args.kind_code, "200");
      const data = await kamisRequest("periodWholesaleProductList", {
        p_startday: args.start_date,
        p_endday: args.end_date,
        p_countrycode: args.region_code || "1101",
        p_itemcategorycode: resolved.category_code,
        p_itemcode: resolved.item_code,
        p_kindcode: resolved.kind_code,
        p_productrankcode: resolveProductRank(args.grade_rank)
      });
      return { content: [{ type: "text", text: JSON.stringify(sanitizeKamisData(data), null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_daily_category_prices",
    {
      title: "KAMIS 일별 부류별 가격 조회",
      description: "최근 일자 기준 부류별 도매 또는 소매 가격을 조회합니다.",
      inputSchema: {
        product_class: z.enum(["01", "02"]).default("02").describe("01 소매, 02 도매"),
        category_code: z.string().default("200").describe("부류 코드"),
        region_code: z.string().optional().describe("지역 코드. 도매는 1101 서울, 2100 부산, 2200 대구, 2401 광주, 2501 대전"),
        date: z.string().optional().describe("기준일 yyyy-MM-dd, 미입력 시 최근 조사일")
      }
    },
    async (args) => {
      const regday = args.date || new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Seoul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date());
      const data = await kamisRequest("dailyPriceByCategoryList", {
        p_product_cls_code: args.product_class,
        p_item_category_code: args.category_code,
        p_country_code: args.region_code,
        p_regday: regday,
        p_convert_kg_yn: "Y"
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_find_item",
    {
      title: "KAMIS 품목·품종 검색",
      description: "제공된 MCPB 코드표 기준으로 품목명과 품종명을 검색합니다. '대파'는 파(246)+대파(00)로 안내합니다.",
      inputSchema: { query: z.string() }
    },
    async ({ query }) => {
      const q = normalizeName(query);
      const rows = Object.entries(KAMIS_CROPS)
        .filter(([name]) => normalizeName(name).includes(q) || q.includes(normalizeName(name)))
        .map(([name, v]) => ({ query_name: name, ...v }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_item_kinds",
    {
      title: "KAMIS 품목별 품종·단위·등급 조회",
      description: "품목코드 또는 품목명에 연결된 품종, 도매·소매 단위와 등급을 보여줍니다.",
      inputSchema: { item: z.string() }
    },
    async ({ item }) => {
      const resolved = resolveCrop(item, undefined, "200");
      const row = KAMIS_ITEMS_BY_CODE[resolved.item_code];
      return { content: [{ type: "text", text: JSON.stringify({ item_code: resolved.item_code, item_name: resolved.item_name, kinds: row.kinds }, null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_credentials_status",
    {
      title: "KAMIS 인증 설정 상태",
      description: "KAMIS 인증 ID와 Key가 서버 환경변수에 설정되어 있는지 확인합니다. 비밀값 자체는 반환하지 않습니다.",
      inputSchema: {}
    },
    async () => {
      const idSet = Boolean(process.env.KAMIS_CERT_ID);
      const keySet = Boolean(process.env.KAMIS_CERT_KEY);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            configured: idSet && keySet,
            cert_id_configured: idSet,
            cert_key_configured: keySet,
            setup: "Render 대시보드의 Environment에서 KAMIS_CERT_ID와 KAMIS_CERT_KEY를 설정하세요."
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

app.get("/health", (_req, res) => res.status(200).json({ status: "ok", service: "kamis-mcp-server" }));
app.get("/", (_req, res) => res.status(200).send("KAMIS MCP server is running. MCP endpoint: /mcp"));

app.options("/mcp", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID"
  });
  res.sendStatus(204);
});

app.post("/mcp", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error?.name || "UnknownError");
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

app.get("/mcp", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(405).json({ error: "This stateless MCP endpoint accepts POST requests only." });
});
app.delete("/mcp", (_req, res) => res.sendStatus(405));

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`KAMIS MCP server listening on port ${port}`);
});
