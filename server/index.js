import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

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
    if (/^condition$/i.test(key) || /cert.?key|cert.?id/i.test(key)) return undefined;
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

async function resolveKamisItemCode(cropName, categoryCode = "200") {
  const listing = await kamisRequest("dailyPriceByCategoryList", {
    p_product_cls_code: "02",
    p_item_category_code: categoryCode,
    p_convert_kg_yn: "Y"
  });
  const rows = Array.isArray(listing?.data) ? listing.data : [];
  const matches = rows.filter((row) => {
    const name = row.item_name ?? row.itemName ?? row.itemname ?? "";
    return normalizeName(name) === normalizeName(cropName);
  });
  if (matches.length !== 1) {
    const available = rows.map((row) => ({
      item_name: row.item_name ?? row.itemName ?? row.itemname ?? null,
      item_code: row.itemcode ?? row.item_code ?? row.itemCode ?? null
    })).filter((row) => row.item_name);
    throw new Error(matches.length
      ? `품목명 '${cropName}'의 코드가 여러 개입니다. 품종을 지정해야 합니다.`
      : `KAMIS 품목 목록에서 '${cropName}'을(를) 찾지 못했습니다. 품목코드표를 확인하세요. 반환된 품목 수: ${rows.length}`);
  }
  const code = matches[0].itemcode ?? matches[0].item_code ?? matches[0].itemCode;
  if (!code) throw new Error(`KAMIS 품목 '${cropName}' 응답에 품목코드가 없습니다.`);
  return String(code);
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

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`KAMIS API HTTP 오류: ${response.status}`);
  const data = await response.json();

  const resultCode = data?.condition?.result_code ?? data?.result_code;
  if (resultCode && !["000", "001"].includes(String(resultCode))) {
    const message = data?.condition?.result_msg ?? data?.condition?.message ?? "KAMIS API 요청 오류";
    throw new Error(`KAMIS 오류 ${resultCode}: ${message}`);
  }
  return data;
}

function makeServer() {
  const server = new McpServer({ name: "kamis-price-info", version: "1.0.0" });

  server.registerTool(
    "kamis_monthly_prices",
    {
      title: "KAMIS 월별 도소매 가격 조회",
      description: "KAMIS 월별 도소매 가격을 조회합니다. 중도매 가격은 product_cls_code=02, 소매는 01입니다. kg 환산은 convert_kg_yn=Y로 요청하세요.",
      inputSchema: {
        year: z.string().regex(/^\d{4}$/).describe("조회 연도 예: 2026"),
        period: z.string().default("1").describe("조회 기간(년), 기본 1"),
        category_code: z.string().default("200").describe("부류 코드: 100 식량작물, 200 채소류, 300 특용작물, 400 과일류, 500 축산물, 600 수산물"),
        item_code: z.string().optional().describe("품목 코드. crop_name을 입력하면 KAMIS 품목목록에서 자동 확인합니다."),
        crop_name: z.string().optional().describe("품목명(예: 양파, 대파, 양배추). item_code 대신 지정 가능"),
        kind_code: z.string().optional().describe("품종 코드"),
        grade_rank: z.string().optional().describe("등급 코드: 상품/중품 등 KAMIS 코드표 기준"),
        county_code: z.string().optional().describe("지역 코드. 미입력 시 전체 지역"),
        product_cls_code: z.enum(["01", "02"]).default("02").describe("01 소매, 02 도매"),
        convert_kg_yn: z.enum(["Y", "N"]).default("Y").describe("kg 단위 환산 여부")
      }
    },
    async (args) => {
      const resolvedItemCode = args.item_code || (args.crop_name
        ? await resolveKamisItemCode(args.crop_name, args.category_code)
        : undefined);
      if (!resolvedItemCode) throw new Error("item_code 또는 crop_name을 지정하세요.");
      const data = await kamisRequest("monthlySalesList", {
        p_yyyy: args.year,
        p_period: args.period,
        p_itemcategorycode: args.category_code,
        p_itemcode: resolvedItemCode,
        p_kindcode: args.kind_code,
        p_graderank: args.grade_rank,
        p_countycode: args.county_code,
        p_productclscode: args.product_cls_code,
        p_convert_kg_yn: args.convert_kg_yn
      });
      if (args.crop_name) {
        const wholesale = (data.price || []).filter((p) => p.productclscode === "02");
        const verified = wholesale.filter((p) => normalizeName(p.caption).includes(normalizeName(args.crop_name)));
        if (!verified.length) {
          const returned = wholesale.map((p) => p.caption);
          throw new Error(`요청 품목 '${args.crop_name}'과 API 응답 품목명이 일치하지 않습니다. 응답: ${returned.join(" | ") || "가격자료 없음"}`);
        }
        data.price = verified;
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "kamis_period_wholesale_prices",
    {
      title: "KAMIS 기간별 도매가격 조회",
      description: "시작일과 종료일 사이의 품목별 도매가격을 조회합니다. 조회 기간은 최대 1년입니다.",
      inputSchema: {
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        region_code: z.string().optional().describe("도매 지역 코드: 1101 서울, 2100 부산, 2200 대구, 2401 광주, 2501 대전. 미입력 시 전체"),
        item_code: z.string().optional(),
        kind_code: z.string().optional(),
        grade_rank: z.string().optional()
      }
    },
    async (args) => {
      const data = await kamisRequest("periodWholesaleProductList", {
        p_startday: args.start_date,
        p_endday: args.end_date,
        p_countrycode: args.region_code,
        p_itemcode: args.item_code,
        p_kindcode: args.kind_code,
        p_graderank: args.grade_rank
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
      const data = await kamisRequest("dailyPriceByCategoryList", {
        p_product_cls_code: args.product_class,
        p_item_category_code: args.category_code,
        p_country_code: args.region_code,
        p_regday: args.date
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    console.error("MCP request failed:", error);
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
