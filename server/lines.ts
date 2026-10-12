export interface ChainDef {
  /**
   * Stations the chain passes through, in order. The build script fills in everything between
   * consecutive waypoints by walking the line's station graph, so only junctions/turns need listing.
   */
  via: string[];
  /** Last station connects back to the first (2호선 본선, 6호선 응암순환). */
  loop?: boolean;
}

export interface LineDef {
  id: string;
  name: string;
  /** Text inside the line badge. */
  short: string;
  color: string;
  /** subwayId values used by the Seoul realtime API. Empty = no realtime data for this line. */
  apiIds: string[];
  /** Picks this line's route relations out of OpenStreetMap by name. */
  osm: RegExp;
  /**
   * A line is drawn as one or more chains: simple paths through stations. Trains are placed on
   * a chain by fractional station index, and headway gaps are measured along a chain.
   */
  chains: ChainDef[];
}

// Skip-stop services would add false "adjacent station" edges.
export const OSM_EXCLUDE = /(?<!광역)급행|특급|직통/;

export const LINES: LineDef[] = [
  {
    id: "1", name: "1호선", short: "1", color: "#0052A4", apiIds: ["1001"], osm: /^수도권 전철 1호선/,
    chains: [
      { via: ["연천", "청량리", "서울", "구로", "인천"] },
      { via: ["구로", "가산디지털단지", "천안", "신창"] },
      { via: ["금천구청", "광명"] },
      { via: ["병점", "서동탄"] },
    ],
  },
  {
    id: "2", name: "2호선", short: "2", color: "#00A84D", apiIds: ["1002"], osm: /^서울 지하철 2호선/,
    chains: [
      // Station-list order is 내선 (clockwise).
      { via: ["시청", "왕십리", "잠실", "강남", "신림", "신도림", "홍대입구", "충정로"], loop: true },
      { via: ["성수", "신설동"] },
      { via: ["신도림", "까치산"] },
    ],
  },
  {
    id: "3", name: "3호선", short: "3", color: "#EF7C1C", apiIds: ["1003"], osm: /^수도권 전철 3호선/,
    chains: [{ via: ["대화", "오금"] }],
  },
  {
    id: "4", name: "4호선", short: "4", color: "#00A5DE", apiIds: ["1004"], osm: /^수도권 전철 4호선/,
    chains: [{ via: ["진접", "서울", "사당", "금정", "오이도"] }],
  },
  {
    id: "5", name: "5호선", short: "5", color: "#996CAC", apiIds: ["1005"], osm: /^서울 지하철 5호선/,
    chains: [{ via: ["방화", "강동", "하남검단산"] }, { via: ["강동", "마천"] }],
  },
  {
    id: "6", name: "6호선", short: "6", color: "#CD7C2F", apiIds: ["1006"], osm: /^서울 지하철 6호선/,
    chains: [
      { via: ["응암", "신내"] },
      { via: ["응암", "역촌", "불광", "독바위", "연신내", "구산"], loop: true },
    ],
  },
  {
    id: "7", name: "7호선", short: "7", color: "#747F00", apiIds: ["1007"], osm: /^서울 지하철 7호선/,
    chains: [{ via: ["장암", "석남"] }],
  },
  {
    id: "8", name: "8호선", short: "8", color: "#E6186C", apiIds: ["1008"], osm: /^서울 지하철 8호선/,
    chains: [{ via: ["별내", "모란"] }],
  },
  {
    id: "9", name: "9호선", short: "9", color: "#BDB092", apiIds: ["1009"], osm: /^서울 지하철 9호선/,
    chains: [{ via: ["개화", "중앙보훈병원"] }],
  },
  {
    id: "K", name: "경의중앙선", short: "경의", color: "#77C4A3", apiIds: ["1063", "1061"], osm: /^경의·중앙선/,
    chains: [{ via: ["문산", "용산", "왕십리", "청량리", "용문"] }, { via: ["가좌", "서울"] }],
  },
  {
    id: "A", name: "공항철도", short: "공항", color: "#0090D2", apiIds: ["1065"], osm: /^인천국제공항철도 일반/,
    chains: [{ via: ["서울", "인천공항2터미널"] }],
  },
  {
    id: "G", name: "경춘선", short: "경춘", color: "#0C8E72", apiIds: ["1067"], osm: /^수도권 전철 경춘선/,
    chains: [{ via: ["청량리", "상봉", "춘천"] }, { via: ["광운대", "상봉"] }],
  },
  {
    id: "SU", name: "수인분당선", short: "수인", color: "#FABE00", apiIds: ["1075"], osm: /^수인·분당선/,
    chains: [{ via: ["청량리", "수서", "수원", "오이도", "인천"] }],
  },
  {
    id: "SB", name: "신분당선", short: "신분", color: "#D4003B", apiIds: ["1077"], osm: /^수도권 전철 신분당선/,
    chains: [{ via: ["신사", "광교"] }],
  },
  {
    id: "UI", name: "우이신설선", short: "우이", color: "#B0CE18", apiIds: ["1092"], osm: /^우이신설선/,
    chains: [{ via: ["북한산우이", "신설동"] }],
  },
  {
    id: "SH", name: "서해선", short: "서해", color: "#8FC31F", apiIds: ["1093"], osm: /^수도권 전철 서해선/,
    chains: [{ via: ["일산", "원시"] }],
  },
  {
    id: "KK", name: "경강선", short: "경강", color: "#003DA5", apiIds: ["1081"], osm: /^수도권 전철 경강선/,
    chains: [{ via: ["판교", "여주"] }],
  },
  {
    id: "SL", name: "신림선", short: "신림", color: "#6789CA", apiIds: ["1094"], osm: /^서울 경전철 신림선/,
    chains: [{ via: ["샛강", "관악산"] }],
  },
  {
    id: "GA", name: "GTX-A", short: "A", color: "#9A6292", apiIds: ["1032"], osm: /^수도권 광역급행철도 A선/,
    chains: [{ via: ["운정중앙", "서울"] }, { via: ["수서", "동탄"] }],
  },
  {
    id: "GP", name: "김포골드라인", short: "김포", color: "#A17800", apiIds: [], osm: /^김포 골드라인/,
    chains: [{ via: ["양촌", "김포공항"] }],
  },
  {
    id: "UJ", name: "의정부경전철", short: "의정", color: "#FDA600", apiIds: [], osm: /^의정부경전철: (발곡 → 탑석|탑석 → 발곡)/,
    chains: [{ via: ["발곡", "탑석"] }],
  },
  {
    id: "EV", name: "용인에버라인", short: "용인", color: "#509F22", apiIds: [], osm: /^용인 경전철/,
    chains: [{ via: ["기흥", "전대·에버랜드"] }],
  },
  {
    id: "I1", name: "인천 1호선", short: "인1", color: "#7CA8D5", apiIds: [], osm: /^인천 도시철도 1호선/,
    chains: [{ via: ["검단호수공원", "송도달빛축제공원"] }],
  },
  {
    id: "I2", name: "인천 2호선", short: "인2", color: "#ED8B00", apiIds: [], osm: /^인천 도시철도 2호선/,
    chains: [{ via: ["검단오류", "운연"] }],
  },
];

// Realtime API name -> OpenStreetMap name, where they disagree (usually a recent rename).
const API_ALIASES: Record<string, string> = {
  지제: "평택지제",
  "4.19 민주묘지": "4.19민주묘지",
  세종왕릉: "세종대왕릉",
  뚝섬유원지: "자양",
  응암순환: "응암",
};

// Same, but only on one line: "총신대입구(이수)" is 총신대입구 on 4호선 and 이수 on 7호선.
const LINE_ALIASES: Record<string, Record<string, string>> = {
  "7": { 총신대입구: "이수" },
};

/** normalizeStation, plus aliases that only apply on `lineId`. */
export const stationOnLine = (lineId: string, name: string) => {
  const n = normalizeStation(name);
  return LINE_ALIASES[lineId]?.[n] ?? n;
};

/** "서울대입구(관악구청)" -> "서울대입구", "서울역" -> "서울", "방배 (백석예술대)" -> "방배" */
export const normalizeStation = (name: string) => {
  const n = name.replace(/\s*\(.*\)\s*$/, "").replace(/역$/, "").trim();
  return API_ALIASES[n] ?? n;
};
