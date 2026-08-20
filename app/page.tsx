"use client";

import { FormEvent, PointerEvent, WheelEvent, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { boardFootprint, zoomForBoardFootprint } from "./board-layout";

type Coordinate = { lat: number; lon: number };

type GeoResult = Coordinate & {
  id: number;
  name: string;
  admin1?: string;
  country?: string;
};

type TerrainKind =
  | "water"
  | "stream"
  | "woods"
  | "orchard"
  | "crops"
  | "scrub"
  | "meadow"
  | "built_area"
  | "building"
  | "road_major"
  | "road"
  | "track"
  | "rail"
  | "runway"
  | "wall";

type TerrainFeature = {
  id: string;
  kind: TerrainKind;
  geometry: Coordinate[];
  closed: boolean;
  name?: string;
  bridge?: boolean;
};

type TerrainData = {
  bounds: { south: number; west: number; north: number; east: number };
  features: TerrainFeature[];
  elevation: null | {
    rows: number;
    columns: number;
    points: Array<Coordinate & { elevation: number | null; row: number; column: number }>;
  };
  generated_at: string;
  osm_timestamp: string | null;
};

type GenerationRequest = {
  id: number;
  center: Coordinate;
  zoom: number;
  label: string;
  span: number;
};

type NavigatorTile = {
  key: string;
  url: string;
  left: number;
  top: number;
};

type MapTreatment = "Classic" | "Muted" | "Contrast";
type RenderLayer =
  | "topography"
  | "water"
  | "vegetation"
  | "fields"
  | "settlements"
  | "roads"
  | "streams"
  | "rail"
  | "airfields"
  | "grid";

type HexCell = {
  x: number;
  y: number;
  row: number;
  column: number;
  id: string;
  coordinate: Coordinate;
  terrain: TerrainKind | "clear";
  buildingCount: number;
  elevation: number | null;
  elevationLevel: number;
};

const TILE_SIZE = 256;
const HEX_METERS = 100;
const DEFAULT_CENTER = { lat: 50.5558, lon: 9.6808 };
const DEFAULT_LABEL = "Fulda Gap, Hesse, Germany";
const LAYERS: Array<{ id: RenderLayer; label: string; kinds: TerrainKind[] }> = [
  { id: "topography", label: "Topography", kinds: [] },
  { id: "water", label: "Water", kinds: ["water"] },
  { id: "vegetation", label: "Woods & scrub", kinds: ["woods", "scrub"] },
  { id: "fields", label: "Fields & orchards", kinds: ["crops", "orchard", "meadow"] },
  { id: "settlements", label: "Settlements", kinds: ["built_area", "building"] },
  { id: "roads", label: "Roads & tracks", kinds: ["road_major", "road", "track", "wall"] },
  { id: "streams", label: "Streams", kinds: ["stream"] },
  { id: "rail", label: "Rail", kinds: ["rail"] },
  { id: "airfields", label: "Airfields", kinds: ["runway"] },
  { id: "grid", label: "Hex grid", kinds: [] },
];

const TOPOGRAPHY_ONLY: Record<RenderLayer, boolean> = {
  topography: true,
  water: false,
  vegetation: false,
  fields: false,
  settlements: false,
  roads: false,
  streams: false,
  rail: false,
  airfields: false,
  grid: false,
};

const PALETTES: Record<MapTreatment, {
  ground: string;
  groundMottle: string;
  hills: string[];
  grid: string;
  water: string;
  waterEdge: string;
  woods: string;
  woodsDark: string;
  crops: string;
  scrub: string;
  built: string;
  road: string;
  roadEdge: string;
}> = {
  Classic: {
    ground: "#dfe0ae",
    groundMottle: "rgba(249, 244, 200, .16)",
    hills: ["#dfe0ae", "#dfc985", "#dfa975", "#c98464", "#a95f52"],
    grid: "rgba(67, 76, 58, .62)",
    water: "#237fbd",
    waterEdge: "#16577d",
    woods: "#2f9860",
    woodsDark: "#17613f",
    crops: "#c9c55f",
    scrub: "#84956c",
    built: "#dbc99f",
    road: "#e4e5df",
    roadEdge: "#8d8d87",
  },
  Muted: {
    ground: "#ddd9b6",
    groundMottle: "rgba(255, 255, 238, .15)",
    hills: ["#ddd9b6", "#d7c697", "#cdae87", "#b68d78", "#946f66"],
    grid: "rgba(63, 68, 57, .56)",
    water: "#5689a9",
    waterEdge: "#3b647a",
    woods: "#5f8d67",
    woodsDark: "#395f43",
    crops: "#bbb66f",
    scrub: "#8c9676",
    built: "#d1c5a8",
    road: "#e7e5dc",
    roadEdge: "#93928c",
  },
  Contrast: {
    ground: "#eee7b6",
    groundMottle: "rgba(255, 255, 255, .13)",
    hills: ["#eee7b6", "#efcc76", "#e49a60", "#c66652", "#894348"],
    grid: "rgba(30, 38, 30, .76)",
    water: "#087fc5",
    waterEdge: "#054a73",
    woods: "#159252",
    woodsDark: "#075932",
    crops: "#d1c52b",
    scrub: "#718f51",
    built: "#e1c48f",
    road: "#ffffff",
    roadEdge: "#60635f",
  },
};

const TERRAIN_POLYGON_PRIORITY: TerrainKind[] = [
  "water",
  "woods",
  "orchard",
  "crops",
  "scrub",
  "meadow",
  "built_area",
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function toWorldPixel({ lat, lon }: Coordinate, zoom: number) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((clamp(lat, -85.0511, 85.0511) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function fromWorldPixel(x: number, y: number, zoom: number): Coordinate {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clamp(lat, -85.0511, 85.0511), lon };
}

function metersPerPixel(lat: number, zoom: number) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function fileSafe(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60) || "terrain";
}

function pseudoRandom(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function columnLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function pointInPolygon(point: Coordinate, polygon: Coordinate[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crosses =
      currentPoint.lat > point.lat !== previousPoint.lat > point.lat &&
      point.lon <
        ((previousPoint.lon - currentPoint.lon) * (point.lat - currentPoint.lat)) /
          (previousPoint.lat - currentPoint.lat || Number.EPSILON) +
          currentPoint.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}

function geometryCenter(geometry: Coordinate[]) {
  const sum = geometry.reduce(
    (result, point) => ({ lat: result.lat + point.lat, lon: result.lon + point.lon }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / geometry.length, lon: sum.lon / geometry.length };
}

function hexPath(context: CanvasRenderingContext2D, x: number, y: number, radius: number, rotationRadians: number) {
  context.beginPath();
  for (let point = 0; point < 6; point += 1) {
    const angle = ((60 * point - 30) * Math.PI) / 180 + rotationRadians;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (point === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
}

function rotatePoint(x: number, y: number, centerX: number, centerY: number, radians: number) {
  const dx = x - centerX;
  const dy = y - centerY;
  return {
    x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians),
    y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians),
  };
}

function chooseElevationInterval(range: number) {
  if (range <= 0) return 0;
  const minimumInterval = range / 4;
  const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  return candidates.find((candidate) => candidate >= minimumInterval) ?? 1000;
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigatorRef = useRef<HTMLDivElement>(null);
  const navigatorDrag = useRef<{ x: number; y: number; worldX: number; worldY: number } | null>(null);
  const [mode, setMode] = useState<"navigate" | "map">("navigate");
  const [navCenter, setNavCenter] = useState<Coordinate>(DEFAULT_CENTER);
  const [navZoom, setNavZoom] = useState(6);
  const [navLabel, setNavLabel] = useState(DEFAULT_LABEL);
  const [navigatorSize, setNavigatorSize] = useState({ width: 1000, height: 600 });
  const [center, setCenter] = useState<Coordinate>(DEFAULT_CENTER);
  const [placeLabel, setPlaceLabel] = useState(DEFAULT_LABEL);
  const [query, setQuery] = useState(DEFAULT_LABEL);
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [zoom, setZoom] = useState(15);
  const [mapRotation, setMapRotation] = useState(0);
  const [rotation, setRotation] = useState(0);
  const [boardCols, setBoardCols] = useState(1);
  const [boardRows, setBoardRows] = useState(1);
  const [treatment, setTreatment] = useState<MapTreatment>("Classic");
  const [layers, setLayers] = useState<Record<RenderLayer, boolean>>({ ...TOPOGRAPHY_ONLY });
  const [showLabels, setShowLabels] = useState(false);
  const [showHexIds, setShowHexIds] = useState(false);
  const [renderState, setRenderState] = useState("Navigate freely · generation paused");
  const [notice, setNotice] = useState("Pan and zoom anywhere. Terrain is generated only when you press the button.");
  const [viewportRevision, setViewportRevision] = useState(0);
  const [generationRequest, setGenerationRequest] = useState<GenerationRequest | null>(null);
  const [terrainData, setTerrainData] = useState<TerrainData | null>(null);
  const [terrainStatus, setTerrainStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [terrainError, setTerrainError] = useState("");

  const scale = useMemo(() => metersPerPixel(center.lat, zoom), [center.lat, zoom]);
  const footprint = useMemo(() => boardFootprint(boardCols, boardRows), [boardCols, boardRows]);
  const nextOutputZoom = useMemo(
    () => zoomForBoardFootprint(navCenter.lat, footprint.widthMeters, footprint.heightMeters),
    [footprint.heightMeters, footprint.widthMeters, navCenter.lat],
  );
  const sheetColumns = footprint.boardCols;
  const sheetRows = footprint.boardRows;
  const elevationValues = useMemo(
    () => terrainData?.elevation?.points.map((point) => point.elevation).filter((value): value is number => value !== null) ?? [],
    [terrainData],
  );
  const elevationMin = elevationValues.length ? Math.min(...elevationValues) : null;
  const elevationMax = elevationValues.length ? Math.max(...elevationValues) : null;
  const elevationInterval =
    elevationMin !== null && elevationMax !== null ? chooseElevationInterval(elevationMax - elevationMin) : 0;
  const enabledLayerNames = useMemo(
    () => LAYERS.filter((layer) => layers[layer.id]).map((layer) => layer.label),
    [layers],
  );
  const layerCounts = useMemo(() => {
    const counts = new Map<RenderLayer, number>();
    for (const layer of LAYERS) {
      if (layer.id === "topography") {
        counts.set(layer.id, terrainData?.elevation?.points.filter((point) => point.elevation !== null).length ?? 0);
      } else if (layer.id === "grid") {
        counts.set(layer.id, 1);
      } else {
        counts.set(
          layer.id,
          terrainData?.features.filter((feature) => layer.kinds.includes(feature.kind)).length ?? 0,
        );
      }
    }
    return counts;
  }, [terrainData]);

  const navigatorTiles = useMemo(() => {
    const world = toWorldPixel(navCenter, navZoom);
    const leftWorld = world.x - navigatorSize.width / 2;
    const topWorld = world.y - navigatorSize.height / 2;
    const minimumX = Math.floor(leftWorld / TILE_SIZE);
    const maximumX = Math.floor((leftWorld + navigatorSize.width) / TILE_SIZE);
    const minimumY = Math.max(0, Math.floor(topWorld / TILE_SIZE));
    const maximumY = Math.min(2 ** navZoom - 1, Math.floor((topWorld + navigatorSize.height) / TILE_SIZE));
    const tiles: NavigatorTile[] = [];
    for (let tileY = minimumY; tileY <= maximumY; tileY += 1) {
      for (let displayX = minimumX; displayX <= maximumX; displayX += 1) {
        const wrappedX = ((displayX % 2 ** navZoom) + 2 ** navZoom) % 2 ** navZoom;
        tiles.push({
          key: `${navZoom}-${displayX}-${tileY}`,
          url: `https://tile.openstreetmap.org/${navZoom}/${wrappedX}/${tileY}.png`,
          left: displayX * TILE_SIZE - leftWorld,
          top: tileY * TILE_SIZE - topWorld,
        });
      }
    }
    return tiles;
  }, [navCenter, navigatorSize, navZoom]);

  const selectionFootprint = useMemo(() => {
    const pixelScale = metersPerPixel(navCenter.lat, navZoom);
    const rawWidth = footprint.widthMeters / pixelScale;
    const rawHeight = footprint.heightMeters / pixelScale;
    const maximumWidth = Math.max(40, navigatorSize.width * 0.72);
    const maximumHeight = Math.max(40, navigatorSize.height * 0.72);
    const fitScale = Math.min(maximumWidth / rawWidth, maximumHeight / rawHeight);
    const minimumLongEdge = 58 * Math.max(footprint.boardCols, footprint.boardRows);
    const readableScale = Math.max(1, minimumLongEdge / Math.max(rawWidth, rawHeight));
    const displayScale = Math.min(fitScale, readableScale);
    return {
      width: Math.max(34, rawWidth * displayScale),
      height: Math.max(34, rawHeight * displayScale),
    };
  }, [footprint, navCenter.lat, navigatorSize, navZoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => setViewportRevision((revision) => revision + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    const navigator = navigatorRef.current;
    if (!navigator) return;
    const updateSize = () => {
      const rect = navigator.getBoundingClientRect();
      if (rect.width && rect.height) setNavigatorSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(navigator);
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    if (!generationRequest) return;
    const controller = new AbortController();
    const loadTerrain = async () => {
      setTerrainStatus("loading");
      setTerrainError("");
      setRenderState("Generating selected area…");
      try {
        const response = await fetch(
          `/api/terrain?lat=${generationRequest.center.lat.toFixed(6)}&lon=${generationRequest.center.lon.toFixed(6)}&span=${generationRequest.span}&revision=${generationRequest.id}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const responseText = await response.text();
        let payload: TerrainData & { error?: string };
        try {
          payload = JSON.parse(responseText) as TerrainData & { error?: string };
        } catch {
          throw new Error(`Terrain endpoint returned ${response.status} instead of map data`);
        }
        if (!response.ok) throw new Error(payload.error || "Terrain source unavailable");
        setTerrainData(payload);
        setTerrainStatus("ready");
        setNotice("Topography rendered from elevation samples. Turn on or solo another layer to inspect it.");
      } catch (error) {
        if (controller.signal.aborted) return;
        setTerrainStatus("error");
        setTerrainError(error instanceof Error ? error.message : "Terrain source unavailable");
        setNotice("Terrain data could not be classified. Retry when the source is available.");
      }
    };
    void loadTerrain();

    return () => {
      controller.abort();
    };
  }, [generationRequest]);

  const renderMap = useCallback(() => {
    // ResizeObserver revisions intentionally invalidate this canvas render.
    void viewportRevision;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = true;

    const width = rect.width;
    const height = rect.height;
    const palette = PALETTES[treatment];
    const visibleKinds = new Set(
      LAYERS.filter((layer) => layers[layer.id]).flatMap((layer) => layer.kinds),
    );
    const centerPixel = toWorldPixel(center, zoom);
    const mapRadians = (mapRotation * Math.PI) / 180;
    const gridRadians = (rotation * Math.PI) / 180;
    const currentScale = metersPerPixel(center.lat, zoom);
    const hexWidth = clamp(HEX_METERS / currentScale, 15, 90);
    const radius = hexWidth / Math.sqrt(3);
    const verticalStep = radius * 1.5;
    const coverage = Math.hypot(width, height) + hexWidth * 5;

    const project = (coordinate: Coordinate) => {
      const world = toWorldPixel(coordinate, zoom);
      const dx = world.x - centerPixel.x;
      const dy = world.y - centerPixel.y;
      return {
        x: width / 2 + dx * Math.cos(mapRadians) - dy * Math.sin(mapRadians),
        y: height / 2 + dx * Math.sin(mapRadians) + dy * Math.cos(mapRadians),
      };
    };

    const screenToCoordinate = (x: number, y: number) => {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const worldX = dx * Math.cos(mapRadians) + dy * Math.sin(mapRadians);
      const worldY = -dx * Math.sin(mapRadians) + dy * Math.cos(mapRadians);
      return fromWorldPixel(centerPixel.x + worldX, centerPixel.y + worldY, zoom);
    };

    context.fillStyle = palette.ground;
    context.fillRect(0, 0, width, height);

    const polygonFeatures = (terrainData?.features ?? [])
      .filter(
        (feature) =>
          feature.closed &&
          TERRAIN_POLYGON_PRIORITY.includes(feature.kind) &&
          visibleKinds.has(feature.kind),
      )
      .map((feature) => ({
        ...feature,
        minLat: Math.min(...feature.geometry.map((point) => point.lat)),
        maxLat: Math.max(...feature.geometry.map((point) => point.lat)),
        minLon: Math.min(...feature.geometry.map((point) => point.lon)),
        maxLon: Math.max(...feature.geometry.map((point) => point.lon)),
      }))
      .sort(
        (a, b) => TERRAIN_POLYGON_PRIORITY.indexOf(a.kind) - TERRAIN_POLYGON_PRIORITY.indexOf(b.kind),
      );
    const buildingPoints = (terrainData?.features ?? [])
      .filter(() => layers.settlements)
      .filter((feature) => feature.kind === "building")
      .map((feature) => project(geometryCenter(feature.geometry)));

    const usableElevations = terrainData?.elevation?.points.filter((point) => point.elevation !== null) ?? [];
    const minElevation = usableElevations.length
      ? Math.min(...usableElevations.map((point) => point.elevation as number))
      : null;
    const maxElevation = usableElevations.length
      ? Math.max(...usableElevations.map((point) => point.elevation as number))
      : null;
    const elevationRange = minElevation !== null && maxElevation !== null ? maxElevation - minElevation : 0;
    const elevationStep = chooseElevationInterval(elevationRange);
    const elevationBase = minElevation !== null && elevationStep ? Math.floor(minElevation / elevationStep) * elevationStep : minElevation;

    const nearestElevation = (coordinate: Coordinate) => {
      let closest: (typeof usableElevations)[number] | null = null;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const point of usableElevations) {
        const distance = (point.lat - coordinate.lat) ** 2 + (point.lon - coordinate.lon) ** 2;
        if (distance < closestDistance) {
          closest = point;
          closestDistance = distance;
        }
      }
      return closest?.elevation ?? null;
    };

    const interpolatedElevation = (coordinate: Coordinate) => {
      const elevation = terrainData?.elevation;
      if (!elevation || !usableElevations.length) return null;
      const rowPosition =
        ((terrainData.bounds.north - coordinate.lat) /
          Math.max(Number.EPSILON, terrainData.bounds.north - terrainData.bounds.south)) *
        (elevation.rows - 1);
      const columnPosition =
        ((coordinate.lon - terrainData.bounds.west) /
          Math.max(Number.EPSILON, terrainData.bounds.east - terrainData.bounds.west)) *
        (elevation.columns - 1);
      const row0 = clamp(Math.floor(rowPosition), 0, elevation.rows - 1);
      const row1 = clamp(Math.ceil(rowPosition), 0, elevation.rows - 1);
      const column0 = clamp(Math.floor(columnPosition), 0, elevation.columns - 1);
      const column1 = clamp(Math.ceil(columnPosition), 0, elevation.columns - 1);
      const rowFraction = clamp(rowPosition - row0, 0, 1);
      const columnFraction = clamp(columnPosition - column0, 0, 1);
      const corners = [
        { row: row0, column: column0, weight: (1 - rowFraction) * (1 - columnFraction) },
        { row: row0, column: column1, weight: (1 - rowFraction) * columnFraction },
        { row: row1, column: column0, weight: rowFraction * (1 - columnFraction) },
        { row: row1, column: column1, weight: rowFraction * columnFraction },
      ];
      let weightedValue = 0;
      let totalWeight = 0;
      for (const corner of corners) {
        const point = elevation.points.find(
          (item) => item.row === corner.row && item.column === corner.column && item.elevation !== null,
        );
        if (!point || point.elevation === null) continue;
        weightedValue += point.elevation * corner.weight;
        totalWeight += corner.weight;
      }
      return totalWeight > 0 ? weightedValue / totalWeight : nearestElevation(coordinate);
    };

    const rawCells: Omit<HexCell, "id" | "coordinate" | "terrain" | "buildingCount" | "elevation" | "elevationLevel">[] = [];
    let rowIndex = 0;
    for (let baseY = height / 2 - coverage; baseY <= height / 2 + coverage; baseY += verticalStep) {
      const offset = rowIndex % 2 ? hexWidth / 2 : 0;
      let columnIndex = 0;
      for (let baseX = width / 2 - coverage + offset; baseX <= width / 2 + coverage; baseX += hexWidth) {
        const rotated = rotatePoint(baseX, baseY, width / 2, height / 2, gridRadians);
        if (
          rotated.x >= -hexWidth &&
          rotated.x <= width + hexWidth &&
          rotated.y >= -hexWidth &&
          rotated.y <= height + hexWidth
        ) {
          rawCells.push({ x: rotated.x, y: rotated.y, row: rowIndex, column: columnIndex });
        }
        columnIndex += 1;
      }
      rowIndex += 1;
    }

    const minimumRow = Math.min(...rawCells.map((cell) => cell.row));
    const minimumColumn = Math.min(...rawCells.map((cell) => cell.column));
    const cells: HexCell[] = rawCells.map((cell) => {
      const coordinate = screenToCoordinate(cell.x, cell.y);
      let terrain: TerrainKind | "clear" = "clear";
      for (const feature of polygonFeatures) {
        if (
          coordinate.lat < feature.minLat ||
          coordinate.lat > feature.maxLat ||
          coordinate.lon < feature.minLon ||
          coordinate.lon > feature.maxLon
        ) continue;
        if (pointInPolygon(coordinate, feature.geometry)) {
          terrain = feature.kind;
          break;
        }
      }
      const buildingCount = buildingPoints.reduce((count, point) => {
        const distance = Math.hypot(point.x - cell.x, point.y - cell.y);
        return count + (distance <= radius * 0.9 ? 1 : 0);
      }, 0);
      if (terrain !== "water" && buildingCount > 0) terrain = "building";
      const elevation = interpolatedElevation(coordinate);
      const elevationLevel =
        elevation !== null && elevationBase !== null && elevationStep
          ? clamp(Math.floor((elevation - elevationBase) / elevationStep), 0, 4)
          : 0;
      return {
        ...cell,
        id: `${columnLabel(cell.column - minimumColumn)}${cell.row - minimumRow + 1}`,
        coordinate,
        terrain,
        buildingCount,
        elevation,
        elevationLevel,
      };
    });

    if (layers.topography && usableElevations.length) {
      for (const cell of cells) {
        hexPath(context, cell.x, cell.y, radius + 0.7, gridRadians);
        context.fillStyle = palette.hills[cell.elevationLevel];
        context.fill();
      }
    }

    for (const cell of cells) {
      if (cell.terrain === "clear" || cell.terrain === "building") continue;
      context.save();
      hexPath(context, cell.x, cell.y, radius - 0.6, gridRadians);
      context.clip();
      const seed = cell.row * 113 + cell.column * 37;

      if (cell.terrain === "water") {
        context.fillStyle = palette.water;
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
        context.strokeStyle = "rgba(255,255,255,.19)";
        context.lineWidth = 1;
        for (let line = -2; line <= 2; line += 1) {
          context.beginPath();
          context.moveTo(cell.x - radius, cell.y + line * 7 + pseudoRandom(seed + line) * 4);
          context.lineTo(cell.x + radius, cell.y + line * 7 - pseudoRandom(seed + line + 1) * 4);
          context.stroke();
        }
      } else if (cell.terrain === "crops") {
        context.fillStyle = "rgba(208, 201, 83, .52)";
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
        context.strokeStyle = "rgba(113, 111, 49, .42)";
        context.lineWidth = 0.75;
        for (let stripe = -radius * 2; stripe < radius * 2; stripe += 4) {
          context.beginPath();
          context.moveTo(cell.x - radius, cell.y + stripe);
          context.lineTo(cell.x + radius, cell.y + stripe - radius);
          context.stroke();
        }
      } else if (cell.terrain === "meadow" || cell.terrain === "built_area") {
        context.fillStyle = cell.terrain === "meadow" ? "rgba(158, 179, 110, .26)" : "rgba(205, 181, 137, .31)";
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
      } else if (cell.terrain === "orchard") {
        context.fillStyle = "rgba(199, 194, 114, .28)";
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
        context.fillStyle = palette.woodsDark;
        const spacing = Math.max(7, radius * 0.42);
        for (let oy = -radius * 0.65; oy <= radius * 0.65; oy += spacing) {
          for (let ox = -radius * 0.6; ox <= radius * 0.6; ox += spacing) {
            const offset = rotatePoint(cell.x + ox, cell.y + oy, cell.x, cell.y, gridRadians);
            context.beginPath();
            context.arc(offset.x, offset.y, Math.max(1.3, radius * 0.075), 0, Math.PI * 2);
            context.fill();
          }
        }
      } else if (cell.terrain === "woods") {
        context.fillStyle = "rgba(116, 151, 80, .22)";
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
        for (let tree = 0; tree < 12; tree += 1) {
          const angle = pseudoRandom(seed + tree * 3.1) * Math.PI * 2;
          const distance = pseudoRandom(seed + tree * 7.7) * radius * 0.7;
          const tx = cell.x + Math.cos(angle) * distance;
          const ty = cell.y + Math.sin(angle) * distance;
          context.fillStyle = tree % 3 === 0 ? palette.woodsDark : palette.woods;
          context.beginPath();
          context.arc(tx, ty, Math.max(1.8, radius * 0.11), 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "rgba(237, 230, 176, .34)";
          context.beginPath();
          context.arc(tx - radius * 0.035, ty - radius * 0.045, Math.max(0.6, radius * 0.035), 0, Math.PI * 2);
          context.fill();
        }
      } else if (cell.terrain === "scrub") {
        context.fillStyle = "rgba(135, 151, 104, .18)";
        context.fillRect(cell.x - radius, cell.y - radius, radius * 2, radius * 2);
        context.strokeStyle = palette.scrub;
        context.lineWidth = 1;
        for (let bush = 0; bush < 14; bush += 1) {
          const bx = cell.x + (pseudoRandom(seed + bush * 2.3) - 0.5) * radius * 1.35;
          const by = cell.y + (pseudoRandom(seed + bush * 5.9) - 0.5) * radius * 1.35;
          context.beginPath();
          context.moveTo(bx - 2, by + 1);
          context.quadraticCurveTo(bx, by - 2, bx + 2, by + 1);
          context.stroke();
        }
      }
      context.restore();
    }

    const traceFeature = (feature: TerrainFeature) => {
      context.beginPath();
      feature.geometry.forEach((coordinate, index) => {
        const point = project(coordinate);
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
    };

    const strokeFeatures = (kind: TerrainKind, edge: string, edgeWidth: number, fill?: string, fillWidth?: number, dash: number[] = []) => {
      if (!visibleKinds.has(kind)) return;
      for (const feature of terrainData?.features ?? []) {
        if (feature.kind !== kind) continue;
        traceFeature(feature);
        context.lineJoin = "round";
        context.lineCap = "round";
        context.setLineDash(dash);
        context.strokeStyle = edge;
        context.lineWidth = feature.bridge ? edgeWidth + 2 : edgeWidth;
        context.stroke();
        if (fill && fillWidth) {
          traceFeature(feature);
          context.setLineDash([]);
          context.strokeStyle = fill;
          context.lineWidth = fillWidth;
          context.stroke();
        }
      }
      context.setLineDash([]);
    };

    strokeFeatures("stream", palette.waterEdge, 5, "#6ab4cf", 2.4);
    strokeFeatures("runway", "#777b7b", 14, "#c5c7c2", 10);
    strokeFeatures("road_major", palette.roadEdge, 10, palette.road, 6.5);
    strokeFeatures("road", palette.roadEdge, 6, palette.road, 3.5);
    strokeFeatures("track", "rgba(105, 89, 63, .82)", 1.8, undefined, undefined, [5, 4]);
    strokeFeatures("rail", "#414642", 6, "#d9d7be", 2.4);
    strokeFeatures("rail", "#414642", 1.1, undefined, undefined, [2, 5]);
    strokeFeatures("wall", "rgba(91, 74, 57, .78)", 1.5, undefined, undefined, [2, 2]);

    for (const cell of cells.filter((item) => item.terrain === "building")) {
      context.save();
      context.translate(cell.x, cell.y);
      context.rotate(gridRadians);
      const count = clamp(Math.ceil(cell.buildingCount / 2) + 1, 2, 6);
      const seed = cell.row * 59 + cell.column * 127;
      for (let building = 0; building < count; building += 1) {
        const bw = clamp(radius * (0.26 + pseudoRandom(seed + building) * 0.22), 5, 13);
        const bh = clamp(radius * (0.18 + pseudoRandom(seed + building + 4) * 0.17), 4, 10);
        const bx = (pseudoRandom(seed + building * 8.1) - 0.5) * radius * 1.15;
        const by = (pseudoRandom(seed + building * 13.7) - 0.5) * radius * 1.1;
        context.save();
        context.translate(bx, by);
        context.rotate((pseudoRandom(seed + building * 17.3) - 0.5) * 0.85);
        context.fillStyle = building % 3 === 0 ? "#9d5549" : building % 3 === 1 ? "#8b724c" : "#726d64";
        context.strokeStyle = "rgba(67, 51, 39, .9)";
        context.lineWidth = 0.8;
        context.fillRect(-bw / 2, -bh / 2, bw, bh);
        context.strokeRect(-bw / 2, -bh / 2, bw, bh);
        context.restore();
      }
      context.restore();
    }

    if (layers.topography && usableElevations.length && maxElevation !== null) {
      const highest = usableElevations.reduce((best, point) =>
        (point.elevation ?? -Infinity) > (best.elevation ?? -Infinity) ? point : best,
      );
      const peak = project(highest);
      if (peak.x > 35 && peak.x < width - 35 && peak.y > 40 && peak.y < height - 35) {
        context.fillStyle = "#f0d33f";
        context.font = "700 10px ui-monospace, monospace";
        context.textAlign = "center";
        context.fillText("△", peak.x, peak.y - 3);
        context.fillText(`${Math.round(maxElevation)} m`, peak.x, peak.y + 9);
      }
    }

    if (layers.grid) {
      context.strokeStyle = palette.grid;
      context.lineWidth = hexWidth < 22 ? 0.55 : 0.85;
      context.fillStyle = "rgba(255, 252, 226, .82)";
      for (const cell of cells) {
        hexPath(context, cell.x, cell.y, radius, gridRadians);
        context.stroke();
        context.beginPath();
        context.arc(cell.x, cell.y, hexWidth < 22 ? 0.7 : 1.15, 0, Math.PI * 2);
        context.fill();
        if (showHexIds && hexWidth > 20) {
          context.fillStyle = "rgba(54, 64, 49, .62)";
          context.font = `${hexWidth > 34 ? 8 : 7}px ui-monospace, monospace`;
          context.textAlign = "center";
          context.fillText(cell.id, cell.x, cell.y - radius * 0.48);
          context.fillStyle = "rgba(255, 252, 226, .82)";
        }
      }
    }

    const frameMargin = Math.max(34, Math.min(width, height) * 0.075);
    const frameX = frameMargin;
    const frameY = frameMargin;
    const frameWidth = width - frameMargin * 2;
    const frameHeight = height - frameMargin * 2;
    context.strokeStyle = "#344032";
    context.lineWidth = 2;
    context.strokeRect(frameX, frameY, frameWidth, frameHeight);
    context.lineWidth = 1;
    context.setLineDash([7, 5]);
    for (let column = 1; column < sheetColumns; column += 1) {
      const x = frameX + (frameWidth * column) / sheetColumns;
      context.beginPath();
      context.moveTo(x, frameY);
      context.lineTo(x, frameY + frameHeight);
      context.stroke();
    }
    for (let row = 1; row < sheetRows; row += 1) {
      const y = frameY + (frameHeight * row) / sheetRows;
      context.beginPath();
      context.moveTo(frameX, y);
      context.lineTo(frameX + frameWidth, y);
      context.stroke();
    }
    context.setLineDash([]);
    if (sheetColumns * sheetRows > 1) {
      context.font = "700 9px ui-monospace, monospace";
      context.textAlign = "left";
      for (let row = 0; row < sheetRows; row += 1) {
        for (let column = 0; column < sheetColumns; column += 1) {
          const label = `BOARD ${row + 1}-${column + 1}`;
          const x = frameX + (frameWidth * column) / sheetColumns + 10;
          const y = frameY + (frameHeight * (row + 1)) / sheetRows - 10;
          const labelWidth = context.measureText(label).width;
          context.fillStyle = "rgba(244,240,204,.88)";
          context.fillRect(x - 4, y - 13, labelWidth + 8, 17);
          context.fillStyle = "#334031";
          context.fillText(label, x, y);
        }
      }
    }
    if (showLabels) {
      context.fillStyle = "rgba(244, 240, 204, .92)";
      context.fillRect(frameX + 10, frameY + 10, Math.min(frameWidth - 20, 395), 56);
      context.fillStyle = "#334031";
      context.textAlign = "left";
      context.font = "700 11px ui-monospace, monospace";
      context.fillText(`AO // ${placeLabel.toUpperCase().slice(0, 44)}`, frameX + 22, frameY + 31);
      context.font = "10px ui-monospace, monospace";
      const relief = minElevation !== null && maxElevation !== null ? ` · EL ${Math.round(minElevation)}–${Math.round(maxElevation)} M` : "";
      context.fillText(`${center.lat.toFixed(5)}°, ${center.lon.toFixed(5)}° · ${HEX_METERS} M HEX${relief}`, frameX + 22, frameY + 50);
    }

    const attribution = terrainData?.elevation
      ? "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors · Elevation SRTM/OpenTopoData"
      : "OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors";
    context.font = "9px ui-sans-serif, sans-serif";
    context.textAlign = "left";
    const attributionWidth = Math.min(width - 20, context.measureText(attribution).width + 18);
    context.fillStyle = "rgba(248, 244, 213, .9)";
    context.fillRect(width - attributionWidth - 8, height - 25, attributionWidth, 18);
    context.fillStyle = "#344032";
    context.fillText(attribution, width - attributionWidth, height - 12);

    const visibleLabel = LAYERS.filter((layer) => layers[layer.id]).map((layer) => layer.label).join(" + ");
    setRenderState(
      terrainStatus === "ready"
        ? `${visibleLabel || "No layers"} ready`
        : terrainStatus === "error"
          ? "Terrain source offline"
          : "Loading source data…",
    );
  }, [center, layers, mapRotation, placeLabel, rotation, sheetColumns, sheetRows, showHexIds, showLabels, terrainData, terrainStatus, treatment, viewportRevision, zoom]);

  useEffect(() => {
    renderMap();
  }, [renderMap]);

  async function searchLocation(event: FormEvent) {
    event.preventDefault();
    setSearchError("");
    setResults([]);

    const coordinateMatch = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coordinateMatch) {
      const lat = Number(coordinateMatch[1]);
      const lon = Number(coordinateMatch[2]);
      if (lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180) {
        setNavCenter({ lat, lon });
        setNavLabel(`AO ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        setNavZoom((current) => Math.max(current, 12));
        setMode("navigate");
        setRenderState("Navigate freely · generation paused");
        setNotice("Coordinates accepted. Adjust the view, then generate when ready.");
        return;
      }
    }

    if (query.trim().length < 2) {
      setSearchError("Enter a city, postal code, or latitude and longitude.");
      return;
    }

    setSearching(true);
    try {
      const response = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=5&language=en&format=json`,
      );
      if (!response.ok) throw new Error("Search unavailable");
      const payload = (await response.json()) as { results?: Array<GeoResult & { latitude: number; longitude: number }> };
      const nextResults = (payload.results ?? []).map((result) => ({
        ...result,
        lat: result.latitude,
        lon: result.longitude,
      }));
      if (!nextResults.length) setSearchError("No matching place found. Try coordinates or a nearby city.");
      setResults(nextResults);
    } catch {
      setSearchError("Place search is offline. Coordinates still work.");
    } finally {
      setSearching(false);
    }
  }

  function chooseLocation(result: GeoResult) {
    const parts = [result.name, result.admin1, result.country].filter(Boolean);
    setNavCenter({ lat: result.lat, lon: result.lon });
    setNavLabel(parts.join(", "));
    setNavZoom((current) => Math.max(current, 12));
    setQuery(parts.join(", "));
    setResults([]);
    setMode("navigate");
    setRenderState("Navigate freely · generation paused");
    setNotice("Location acquired. Pan or zoom without generating terrain.");
  }

  function useCurrentPosition() {
    if (!navigator.geolocation) {
      setSearchError("Location access is not available in this browser.");
      return;
    }
    setNotice("Acquiring device position…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const next = { lat: position.coords.latitude, lon: position.coords.longitude };
        setNavCenter(next);
        setNavLabel("Current position");
        setNavZoom(14);
        setQuery(`${next.lat.toFixed(5)}, ${next.lon.toFixed(5)}`);
        setMode("navigate");
        setRenderState("Navigate freely · generation paused");
        setNotice("Position acquired. Adjust the view, then generate when ready.");
      },
      () => setNotice("Location permission was not granted. Enter coordinates instead."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  function handleNavigatorPointerDown(event: PointerEvent<HTMLDivElement>) {
    const world = toWorldPixel(navCenter, navZoom);
    navigatorDrag.current = { x: event.clientX, y: event.clientY, worldX: world.x, worldY: world.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleNavigatorPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!navigatorDrag.current) return;
    const deltaX = event.clientX - navigatorDrag.current.x;
    const deltaY = event.clientY - navigatorDrag.current.y;
    const nextCenter = fromWorldPixel(
      navigatorDrag.current.worldX - deltaX,
      navigatorDrag.current.worldY - deltaY,
      navZoom,
    );
    setNavCenter(nextCenter);
    setNavLabel(`Selected area · ${nextCenter.lat.toFixed(3)}, ${nextCenter.lon.toFixed(3)}`);
  }

  function handleNavigatorPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!navigatorDrag.current) return;
    navigatorDrag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function handleNavigatorWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const nextZoom = clamp(navZoom + (event.deltaY < 0 ? 1 : -1), 2, 17);
    if (nextZoom === navZoom) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    const currentWorld = toWorldPixel(navCenter, navZoom);
    const cursorCoordinate = fromWorldPixel(currentWorld.x + offsetX, currentWorld.y + offsetY, navZoom);
    const cursorAtNextZoom = toWorldPixel(cursorCoordinate, nextZoom);
    setNavCenter(fromWorldPixel(cursorAtNextZoom.x - offsetX, cursorAtNextZoom.y - offsetY, nextZoom));
    setNavZoom(nextZoom);
  }

  function generateSelectedMap() {
    const outputZoom = zoomForBoardFootprint(navCenter.lat, footprint.widthMeters, footprint.heightMeters);
    const span = footprint.requestSpanMeters;
    const request: GenerationRequest = {
      id: Date.now(),
      center: navCenter,
      zoom: outputZoom,
      label: navLabel,
      span,
    };
    setCenter(request.center);
    setZoom(request.zoom);
    setPlaceLabel(request.label);
    setTerrainData(null);
    setTerrainError("");
    setLayers({ ...TOPOGRAPHY_ONLY });
    setShowHexIds(false);
    setShowLabels(false);
    setMode("map");
    setTerrainStatus("loading");
    setGenerationRequest(request);
    setNotice(`Generating topography for a ${footprint.boardCols} × ${footprint.boardRows} board mosaic…`);
  }

  function returnToNavigator() {
    setNavCenter(center);
    setNavZoom(zoom);
    setNavLabel(placeLabel);
    setMode("navigate");
    setRenderState("Navigate freely · generation paused");
    setNotice("Generation paused. Pan and zoom freely, then generate again when ready.");
  }

  function retryGeneration() {
    if (!generationRequest) return;
    setGenerationRequest({ ...generationRequest, id: Date.now() });
  }

  function updateBoardLayout(axis: "cols" | "rows", value: number) {
    if (axis === "cols") setBoardCols(value);
    else setBoardRows(value);
    setTerrainData(null);
    setTerrainError("");
    setGenerationRequest(null);
    setMode("navigate");
    setRenderState("Board layout updated · generation paused");
    setNotice("The footprint now matches the selected board mosaic. Position it and generate again.");
  }

  function exportPng() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) {
        setNotice("Map export could not be prepared. Try again once classification is complete.");
        return;
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileSafe(placeLabel)}-${footprint.boardCols}x${footprint.boardRows}-mbt-map.png`;
      link.click();
      URL.revokeObjectURL(link.href);
      setNotice("MBT-style map PNG exported with data attribution.");
    }, "image/png");
  }

  function exportPlan() {
    const terrainCounts = (terrainData?.features ?? []).reduce<Record<string, number>>((counts, feature) => {
      counts[feature.kind] = (counts[feature.kind] ?? 0) + 1;
      return counts;
    }, {});
    const plan = {
      title: placeLabel,
      center,
      zoom,
      hex_meters: HEX_METERS,
      map_rotation_degrees: mapRotation,
      grid_rotation_degrees: rotation,
      board_layout: {
        boards_wide: footprint.boardCols,
        boards_high: footprint.boardRows,
        board_count: footprint.boardCount,
        total_hex_columns: footprint.totalHexColumns,
        total_hex_rows: footprint.totalHexRows,
        footprint_meters: { width: footprint.widthMeters, height: footprint.heightMeters },
      },
      map_finish: treatment,
      visible_layers: enabledLayerNames,
      terrain_classification: terrainCounts,
      elevation_meters: {
        minimum: elevationMin,
        maximum: elevationMax,
        display_interval: elevationInterval || null,
        sample_count: layerCounts.get("topography") ?? 0,
      },
      source_timestamp: terrainData?.osm_timestamp ?? null,
      generated_at: new Date().toISOString(),
      attribution: ["OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors, ODbL", "Elevation: SRTM via OpenTopoData"],
    };
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${fileSafe(placeLabel)}-${footprint.boardCols}x${footprint.boardRows}-mbt-plan.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice("Derived terrain plan exported.");
  }

  function setLayerVisible(layer: RenderLayer, visible: boolean) {
    setLayers((current) => ({ ...current, [layer]: visible }));
  }

  function soloLayer(layer: RenderLayer) {
    setLayers(
      Object.fromEntries(LAYERS.map((item) => [item.id, item.id === layer])) as Record<RenderLayer, boolean>,
    );
    if (layer !== "grid") setShowHexIds(false);
    setShowLabels(false);
    setNotice(`${LAYERS.find((item) => item.id === layer)?.label ?? layer} isolated for inspection.`);
  }

  return (
    <main className="workbench-shell">
      <header className="masthead">
        <a className="brand" href="#top" aria-label="Terrain 100 home">
          <span className="brand-mark">T/100</span>
          <span>
            <strong>TERRAIN / 100</strong>
            <small>MBT MAP WORKBENCH</small>
          </span>
        </a>
        <div className="status-line" aria-live="polite">
          <span className="status-dot" />
          <span>{renderState}</span>
          <span className="status-divider" />
          <span>PRIVATE WORKSPACE</span>
        </div>
      </header>

      <section className="workspace" id="top">
        <aside className="control-rail" aria-label="Map controls">
          <div className="rail-intro">
            <span className="eyebrow">DERIVED GAME TERRAIN</span>
            <h1>Build a real MBT-style battlefield.</h1>
            <p>First locate the ground without generating anything. When the center is right, build the MBT map once and inspect its layers.</p>
          </div>

          <form className="location-form" onSubmit={searchLocation}>
            <label htmlFor="location">Location or coordinates</label>
            <div className="search-row">
              <input
                id="location"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Fulda, Germany or 50.55, 9.68"
                autoComplete="off"
              />
              <button className="square-button" type="submit" aria-label="Find location" disabled={searching}>
                {searching ? "…" : "↗"}
              </button>
            </div>
            <button className="position-button" type="button" onClick={useCurrentPosition}>
              <span>◎</span> Use my position
            </button>
            {searchError ? <p className="form-error">{searchError}</p> : null}
            {results.length ? (
              <div className="search-results" role="listbox" aria-label="Location results">
                {results.map((result) => (
                  <button key={result.id} type="button" onClick={() => chooseLocation(result)}>
                    <strong>{result.name}</strong>
                    <span>{[result.admin1, result.country].filter(Boolean).join(" · ")}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </form>

          <fieldset className="layout-picker">
            <legend>BOARD LAYOUT</legend>
            <div className="layout-fields">
              <label><span>Wide</span><select aria-label="Boards wide" value={boardCols} onChange={(event) => updateBoardLayout("cols", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <b aria-hidden="true">×</b>
              <label><span>High</span><select aria-label="Boards high" value={boardRows} onChange={(event) => updateBoardLayout("rows", Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            </div>
            <p className="layout-summary"><strong>{footprint.boardCount} {footprint.boardCount === 1 ? "board" : "boards"}</strong><span>{(footprint.widthMeters / 1000).toFixed(2)} × {(footprint.heightMeters / 1000).toFixed(2)} km · {footprint.totalHexColumns} × {footprint.totalHexRows} hex field</span></p>
          </fieldset>

          {mode === "navigate" ? (
            <>
              <div className="control-group">
                <div className="control-heading"><span>NAVIGATOR ZOOM</span><output>{navZoom}</output></div>
                <input aria-label="Navigator zoom" type="range" min="2" max="17" step="1" value={navZoom} onChange={(event) => setNavZoom(Number(event.target.value))} />
                <div className="range-labels"><span>WORLD</span><span>REGION</span><span>LOCAL</span></div>
              </div>
              <div className="generation-card">
                <span className="eyebrow">NEXT MAP CENTER</span>
                <strong>{navCenter.lat.toFixed(5)}, {navCenter.lon.toFixed(5)}</strong>
                <p>{footprint.boardCols} × {footprint.boardRows} boards · {(footprint.widthMeters / 1000).toFixed(2)} × {(footprint.heightMeters / 1000).toFixed(2)} km · output detail {nextOutputZoom}.</p>
                <button type="button" className="primary-action generate-action" onClick={generateSelectedMap}>
                  {footprint.boardCount === 1 ? "Generate MBT board here" : `Generate ${footprint.boardCols} × ${footprint.boardRows} boards here`} <span>→</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="generated-area-card">
                <span className="eyebrow">GENERATED AREA</span>
                <strong>{center.lat.toFixed(5)}, {center.lon.toFixed(5)}</strong>
                <small>Detail {zoom} · terrain remains fixed while you style the map</small>
                <button type="button" className="secondary-action" onClick={returnToNavigator}>Reposition map</button>
              </div>

          <div className="control-group">
            <div className="control-heading"><span>MAP ROTATION</span><output>{mapRotation > 0 ? "+" : ""}{mapRotation}°</output></div>
            <input
              aria-label="Map rotation"
              type="range"
              min="-180"
              max="180"
              step="1"
              value={mapRotation}
              onChange={(event) => setMapRotation(Number(event.target.value))}
            />
            <div className="range-labels"><span>-180°</span><span>NORTH UP</span><span>+180°</span></div>
            <div className="rotation-actions" aria-label="Map rotation adjustments">
              <button type="button" onClick={() => setMapRotation((value) => Math.max(-180, value - 5))}>−5°</button>
              <button type="button" onClick={() => setMapRotation(0)}>North up</button>
              <button type="button" onClick={() => setMapRotation((value) => Math.min(180, value + 5))}>+5°</button>
            </div>
          </div>

          <div className="control-group">
            <div className="control-heading"><span>GRID HEADING</span><output>{rotation.toString().padStart(3, "0")}°</output></div>
            <input aria-label="Hex grid rotation" type="range" min="0" max="59" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} />
            <div className="range-labels"><span>0°</span><span>HEX OFFSET</span><span>59°</span></div>
          </div>

          <fieldset className="segmented-control">
            <legend>MAP FINISH</legend>
            <div>
              {(["Classic", "Muted", "Contrast"] as MapTreatment[]).map((item) => (
                <button key={item} type="button" className={treatment === item ? "active" : ""} onClick={() => setTreatment(item)} aria-pressed={treatment === item}>
                  {item}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="layer-stack">
            <legend>RENDER LAYERS</legend>
            <div className="layer-actions">
              <button type="button" onClick={() => soloLayer("topography")}>Topography only</button>
              <button
                type="button"
                onClick={() => setLayers(Object.fromEntries(LAYERS.map((item) => [item.id, true])) as Record<RenderLayer, boolean>)}
              >
                All on
              </button>
              <button
                type="button"
                onClick={() => setLayers(Object.fromEntries(LAYERS.map((item) => [item.id, false])) as Record<RenderLayer, boolean>)}
              >
                All off
              </button>
            </div>
            <div className="layer-list">
              {LAYERS.map((layer) => (
                <div className="layer-row" key={layer.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={layers[layer.id]}
                      onChange={(event) => setLayerVisible(layer.id, event.target.checked)}
                    />
                    <span>{layer.label}</span>
                    <output>{layerCounts.get(layer.id) ?? 0}</output>
                  </label>
                  <button type="button" onClick={() => soloLayer(layer.id)} aria-label={`Show only ${layer.label}`}>
                    Solo
                  </button>
                </div>
              ))}
            </div>
            <p className="layer-note">Counts are source features; topography is the number of elevation samples.</p>
          </fieldset>

          <div className="switches" aria-label="Map annotations">
            <label><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} /><span>Map plate</span></label>
            <label><input type="checkbox" checked={showHexIds} disabled={!layers.grid} onChange={(event) => setShowHexIds(event.target.checked)} /><span>Hex coordinates</span></label>
          </div>

          <div className="terrain-key" aria-label="Terrain key">
            <span className="key-title">TERRAIN KEY</span>
            <div><i className="key-woods" />Woods</div>
            <div><i className="key-crops" />Crops</div>
            <div><i className="key-water" />Water</div>
            <div><i className="key-built" />Buildings</div>
            <div><i className="key-hill" />Elevation</div>
            <div><i className="key-road" />Road</div>
          </div>
            </>
          )}
        </aside>

        <section className="map-stage" aria-label={mode === "navigate" ? "World map navigator" : "Interactive MBT-style terrain map"}>
          <div className="mode-switch" aria-label="Workbench stage">
            <button type="button" className={mode === "navigate" ? "active" : ""} onClick={() => { if (mode === "map") returnToNavigator(); }}>
              <span>01</span> Locate
            </button>
            <button type="button" className={mode === "map" ? "active" : ""} disabled={!generationRequest} onClick={() => setMode("map")}>
              <span>02</span> Render
            </button>
          </div>

          {mode === "navigate" ? (
            <>
              <div className="map-toolbar">
                <div>
                  <span className="eyebrow">NAVIGATOR · TERRAIN GENERATION PAUSED</span>
                  <h2>{navLabel}</h2>
                </div>
                <div className="toolbar-readout">
                  <span>LAT {navCenter.lat.toFixed(5)}</span>
                  <span>LON {navCenter.lon.toFixed(5)}</span>
                  <span>ZOOM {navZoom}</span>
                  <span>{footprint.boardCols} × {footprint.boardRows} BOARDS</span>
                </div>
              </div>

              <div
                className="canvas-frame navigator-frame"
                ref={navigatorRef}
                onPointerDown={handleNavigatorPointerDown}
                onPointerMove={handleNavigatorPointerMove}
                onPointerUp={handleNavigatorPointerUp}
                onPointerCancel={() => { navigatorDrag.current = null; }}
                onWheel={handleNavigatorWheel}
                aria-label="Pan and zoom the world map to select the center of the next generated map"
              >
                <div className="navigator-tiles" aria-hidden="true">
                  {navigatorTiles.map((tile) => (
                    <img
                      key={tile.key}
                      src={tile.url}
                      alt=""
                      draggable={false}
                      style={{ left: tile.left, top: tile.top }}
                    />
                  ))}
                </div>
                <div className="selection-reticle" style={{ width: selectionFootprint.width, height: selectionFootprint.height }} aria-hidden="true">
                  {Array.from({ length: footprint.boardCols - 1 }, (_, index) => <i key={`col-${index}`} className="reticle-seam is-vertical" style={{ left: `${((index + 1) / footprint.boardCols) * 100}%` }} />)}
                  {Array.from({ length: footprint.boardRows - 1 }, (_, index) => <i key={`row-${index}`} className="reticle-seam is-horizontal" style={{ top: `${((index + 1) / footprint.boardRows) * 100}%` }} />)}
                  <span>{footprint.boardCols} × {footprint.boardRows} BOARD FOOTPRINT</span>
                </div>
                <div className="navigator-crosshair" aria-hidden="true"><i /><i /></div>
                <div className="navigator-zoom" aria-label="Navigator zoom controls">
                  <button type="button" onClick={() => setNavZoom((value) => clamp(value + 1, 2, 17))} aria-label="Zoom in">+</button>
                  <output>{navZoom}</output>
                  <button type="button" onClick={() => setNavZoom((value) => clamp(value - 1, 2, 17))} aria-label="Zoom out">−</button>
                </div>
                <div className="osm-credit">
                  © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
                </div>
              </div>

              <div className="map-footer navigator-footer">
                <p><span className="pulse" />Pan, wheel, search, and zoom freely. No terrain request is running.</p>
                <button type="button" className="primary-action generate-action" onClick={generateSelectedMap}>
                  {footprint.boardCount === 1 ? "Generate MBT board here" : `Generate ${footprint.boardCols} × ${footprint.boardRows} boards here`} <span>→</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="map-toolbar">
                <div>
                  <span className="eyebrow">VISIBLE · {enabledLayerNames.join(" + ") || "NO LAYERS"}</span>
                  <h2>{placeLabel}</h2>
                </div>
                <div className="toolbar-readout">
                  <span>LAT {center.lat.toFixed(5)}</span>
                  <span>LON {center.lon.toFixed(5)}</span>
                  <span>{footprint.boardCols} × {footprint.boardRows} BOARDS</span>
                </div>
              </div>

              <div className="canvas-frame map-output-frame" style={{ "--board-aspect": footprint.aspectRatio } as CSSProperties}>
                <canvas ref={canvasRef} aria-label={`Derived MBT-style terrain map centered on ${placeLabel} with 100-meter hexes`} />
                <div className="north-arrow" aria-hidden="true"><span>TRUE N</span><b style={{ transform: `rotate(${mapRotation}deg)` }}>↑</b></div>
                <div className="map-scale" aria-hidden="true"><i /><span>100 m / hex</span></div>
                {terrainStatus === "loading" ? <div className="generation-overlay"><span /><strong>Generating selected area</strong><small>Navigation is locked to the chosen center.</small></div> : null}
                <div className="osm-credit">
                  <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>
                  {" © "}<a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
                  {" · Data © "}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
                </div>
              </div>

              <div className="map-footer">
                <p><span className="pulse" />{terrainError || notice}</p>
                <div className="export-actions">
                  <button type="button" className="secondary-action" onClick={returnToNavigator}>Reposition</button>
                  {terrainStatus === "error" ? <button type="button" className="secondary-action" onClick={retryGeneration}>Retry terrain</button> : null}
                  <button type="button" className="secondary-action" onClick={exportPlan} disabled={terrainStatus !== "ready"}>Export plan</button>
                  <button type="button" className="primary-action" onClick={exportPng} disabled={terrainStatus !== "ready"}>Export map PNG <span>↓</span></button>
                </div>
              </div>
            </>
          )}
        </section>
      </section>

      {mode === "navigate" ? (
        <section className="metrics-strip" aria-label="Navigator status">
          <div><span>MODE</span><strong>Locate</strong><small>terrain generation paused</small></div>
          <div><span>NAVIGATOR ZOOM</span><strong>{navZoom}</strong><small>world to local</small></div>
          <div><span>NEXT CENTER</span><strong>{navCenter.lat.toFixed(3)}</strong><small>{navCenter.lon.toFixed(3)} longitude</small></div>
          <div><span>OUTPUT DETAIL</span><strong>{nextOutputZoom}</strong><small>{footprint.boardCols} × {footprint.boardRows} footprint fit</small></div>
          <div><span>GENERATION</span><strong>Manual</strong><small>button press only</small></div>
        </section>
      ) : (
        <section className="metrics-strip" aria-label="Map specifications">
          <div><span>HEX SCALE</span><strong>100 m</strong><small>ground distance</small></div>
          <div><span>VISIBLE LAYERS</span><strong>{enabledLayerNames.length}</strong><small>{enabledLayerNames.join(" · ") || "none"}</small></div>
          <div><span>RELIEF</span><strong>{elevationMin !== null && elevationMax !== null ? `${Math.round(elevationMin)}–${Math.round(elevationMax)} m` : "—"}</strong><small>{layerCounts.get("topography") ?? 0} samples · {elevationInterval ? `${elevationInterval} m bands` : "flat"}</small></div>
          <div><span>BOARD ARRAY</span><strong>{footprint.boardCols} × {footprint.boardRows}</strong><small>{footprint.boardCount} seamless {footprint.boardCount === 1 ? "board" : "boards"}</small></div>
          <div><span>ORIENTATION</span><strong>{mapRotation > 0 ? "+" : ""}{mapRotation}°</strong><small>map rotation · grid {rotation}°</small></div>
        </section>
      )}

      <footer>
        <p>Derived-map prototype. Not affiliated with GMT Games. No GMT map art or source files are served.</p>
        <p><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> © <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · Elevation: <a href="https://www.opentopodata.org/" target="_blank" rel="noreferrer">SRTM via OpenTopoData</a></p>
        <p>Created by <strong>Stephen G. Rider</strong> · <a href="mailto:rider.sg@gmail.com">rider.sg@gmail.com</a> · <a href="https://github.com/CaliTarheel/terrain-100-maps" target="_blank" rel="noreferrer">source on GitHub</a> · MIT licensed—retain attribution.</p>
      </footer>
    </main>
  );
}
