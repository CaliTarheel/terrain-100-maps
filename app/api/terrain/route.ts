import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

type GeoPoint = { lat: number; lon: number };

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

type TileProperties = Record<string, string | number | boolean>;

type TerrainFeature = {
  id: string;
  kind: TerrainKind;
  geometry: GeoPoint[];
  closed: boolean;
  name?: string;
  bridge?: boolean;
};

const FEATURE_LIMITS: Record<TerrainKind, number> = {
  water: 700,
  stream: 800,
  woods: 900,
  orchard: 500,
  crops: 900,
  scrub: 500,
  meadow: 700,
  built_area: 700,
  building: 1800,
  road_major: 600,
  road: 1600,
  track: 1200,
  rail: 500,
  runway: 200,
  wall: 400,
};

const TILEJSON_URL = "https://tiles.openfreemap.org/planet";
const VECTOR_LAYERS = ["landcover", "landuse", "park", "water", "waterway", "transportation", "aeroway", "building"];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function longitudeToTileX(lon: number, zoom: number) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latitudeToTileY(lat: number, zoom: number) {
  const radians = (clamp(lat, -85.0511, 85.0511) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom;
}

function classifyTileFeature(layer: string, properties: TileProperties): TerrainKind | null {
  const featureClass = String(properties.class ?? "");
  const subclass = String(properties.subclass ?? "");

  if (layer === "building") return "building";
  if (layer === "water") return "water";
  if (layer === "waterway") return "stream";
  if (layer === "park") return "meadow";
  if (layer === "aeroway" && /^(runway|taxiway)$/.test(featureClass)) return "runway";

  if (layer === "landcover") {
    if (featureClass === "wood") return "woods";
    if (/^(orchard|vineyard|plant_nursery)$/.test(subclass)) return "orchard";
    if (featureClass === "farmland" || /^(farm|farmland)$/.test(subclass)) return "crops";
    if (featureClass === "wetland" || /^(scrub|heath|wetland|marsh|reedbed|swamp)$/.test(subclass)) return "scrub";
    if (featureClass === "grass") return "meadow";
  }

  if (layer === "landuse") {
    if (/^(residential|commercial|industrial|retail|hospital|school|cemetery)$/.test(featureClass)) return "built_area";
    if (/^(pitch|track|park|grass)$/.test(featureClass)) return "meadow";
  }

  if (layer === "transportation") {
    if (featureClass === "rail" || subclass === "rail") return "rail";
    if (/^(path|pedestrian|track)$/.test(featureClass) || /^(path|track)$/.test(subclass)) return "track";
    if (/^(motorway|trunk|primary|secondary)$/.test(featureClass)) return "road_major";
    if (featureClass) return "road";
  }

  return null;
}

function toPoints(positions: number[][]) {
  return positions
    .filter((position) => position.length >= 2 && Number.isFinite(position[0]) && Number.isFinite(position[1]))
    .map((position) => ({ lon: position[0], lat: position[1] }));
}

function simplifyGeometry(points: GeoPoint[]) {
  if (points.length <= 160) return points;
  const step = Math.ceil(points.length / 160);
  return points.filter((_, index) => index === 0 || index === points.length - 1 || index % step === 0);
}

function centerOfGeometry(points: GeoPoint[]) {
  const sum = points.reduce(
    (result, point) => ({ lat: result.lat + point.lat, lon: result.lon + point.lon }),
    { lat: 0, lon: 0 },
  );
  return { lat: sum.lat / points.length, lon: sum.lon / points.length };
}

function intersectsBounds(
  points: GeoPoint[],
  bounds: { south: number; west: number; north: number; east: number },
) {
  const minimumLat = Math.min(...points.map((point) => point.lat));
  const maximumLat = Math.max(...points.map((point) => point.lat));
  const minimumLon = Math.min(...points.map((point) => point.lon));
  const maximumLon = Math.max(...points.map((point) => point.lon));
  return !(
    maximumLat < bounds.south ||
    minimumLat > bounds.north ||
    maximumLon < bounds.west ||
    minimumLon > bounds.east
  );
}

function evenlySample<T>(items: T[], limit: number) {
  if (items.length <= limit) return items;
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)]);
}

function geometryParts(geometry: GeoJSON.Geometry) {
  const parts: Array<{ points: GeoPoint[]; closed: boolean }> = [];
  if (geometry.type === "LineString") {
    parts.push({ points: toPoints(geometry.coordinates), closed: false });
  } else if (geometry.type === "MultiLineString") {
    for (const line of geometry.coordinates) parts.push({ points: toPoints(line), closed: false });
  } else if (geometry.type === "Polygon") {
    if (geometry.coordinates[0]) parts.push({ points: toPoints(geometry.coordinates[0]), closed: true });
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      if (polygon[0]) parts.push({ points: toPoints(polygon[0]), closed: true });
    }
  }
  return parts;
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadTileTemplate() {
  const response = await fetchWithTimeout(TILEJSON_URL, 12000);
  if (!response.ok) throw new Error(`Vector tile catalog returned ${response.status}`);
  const tilejson = (await response.json()) as { tiles?: string[] };
  const template = tilejson.tiles?.[0];
  if (!template) throw new Error("Vector tile catalog did not return a tile URL");
  return template;
}

async function loadVectorFeatures(bounds: { south: number; west: number; north: number; east: number }) {
  const template = await loadTileTemplate();
  let tileZoom = 14;
  let tiles: Array<{ x: number; y: number; z: number }> = [];

  while (tileZoom >= 12) {
    const tileLimit = 2 ** tileZoom;
    const minimumX = clamp(Math.floor(longitudeToTileX(bounds.west, tileZoom)), 0, tileLimit - 1);
    const maximumX = clamp(Math.floor(longitudeToTileX(bounds.east, tileZoom)), 0, tileLimit - 1);
    const minimumY = clamp(Math.floor(latitudeToTileY(bounds.north, tileZoom)), 0, tileLimit - 1);
    const maximumY = clamp(Math.floor(latitudeToTileY(bounds.south, tileZoom)), 0, tileLimit - 1);
    tiles = [];
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) tiles.push({ x, y, z: tileZoom });
    }
    if (tiles.length <= 36 || tileZoom === 12) break;
    tileZoom -= 1;
  }

  const responses = await Promise.all(
    tiles.map(async (tile) => {
      const tileUrl = template
        .replace("{z}", String(tile.z))
        .replace("{x}", String(tile.x))
        .replace("{y}", String(tile.y));
      const response = await fetchWithTimeout(tileUrl, 16000);
      if (!response.ok) throw new Error(`Vector terrain tile returned ${response.status}`);
      return { tile, buffer: await response.arrayBuffer() };
    }),
  );

  const features: TerrainFeature[] = [];
  for (const { tile, buffer } of responses) {
    if (!buffer.byteLength) continue;
    const vectorTile = new VectorTile(new PbfReader(buffer));
    for (const layerName of VECTOR_LAYERS) {
      const layer = vectorTile.layers[layerName];
      if (!layer) continue;
      for (let index = 0; index < layer.length; index += 1) {
        const vectorFeature = layer.feature(index);
        const kind = classifyTileFeature(layerName, vectorFeature.properties);
        if (!kind) continue;
        const geojson = vectorFeature.toGeoJSON(tile.x, tile.y, tile.z);
        if (!geojson.geometry) continue;
        const parts = geometryParts(geojson.geometry);
        parts.forEach((part, partIndex) => {
          const points = simplifyGeometry(part.points);
          if (points.length < 2) return;
          const outputGeometry = kind === "building" ? [centerOfGeometry(points)] : points;
          if (!intersectsBounds(outputGeometry, bounds)) return;
          features.push({
            id: `${tile.z}-${tile.x}-${tile.y}-${layerName}-${vectorFeature.id ?? index}-${partIndex}`,
            kind,
            geometry: outputGeometry,
            closed: part.closed,
            name: typeof vectorFeature.properties.name === "string" ? vectorFeature.properties.name : undefined,
            bridge: vectorFeature.properties.brunnel === "bridge",
          });
        });
      }
    }
  }

  const balancedFeatures = (Object.keys(FEATURE_LIMITS) as TerrainKind[]).flatMap((kind) =>
    evenlySample(
      features.filter((feature) => feature.kind === kind),
      FEATURE_LIMITS[kind],
    ),
  );
  return {
    features: balancedFeatures,
    sourceFeatureCount: features.length,
    tileZoom,
    tileCount: tiles.length,
  };
}

async function loadElevation(bounds: { south: number; west: number; north: number; east: number }) {
  const rows = 6;
  const columns = 8;
  const locations: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = bounds.north - ((bounds.north - bounds.south) * row) / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const lon = bounds.west + ((bounds.east - bounds.west) * column) / (columns - 1);
      locations.push(`${lat.toFixed(6)},${lon.toFixed(6)}`);
    }
  }

  try {
    const url = new URL("https://api.opentopodata.org/v1/srtm90m");
    url.searchParams.set("locations", locations.join("|"));
    url.searchParams.set("interpolation", "cubic");
    const response = await fetchWithTimeout(url.toString(), 16000);
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      results?: Array<{ elevation: number | null; location: { lat: number; lng: number } }>;
    };
    const points = (payload.results ?? []).map((result, index) => ({
      lat: result.location.lat,
      lon: result.location.lng,
      elevation: result.elevation,
      row: Math.floor(index / columns),
      column: index % columns,
    }));
    return { rows, columns, points };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const span = Math.min(6000, Math.max(1000, Number(url.searchParams.get("span")) || 3200));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -85 || lat > 85 || lon < -180 || lon > 180) {
    return Response.json({ error: "Valid latitude and longitude are required." }, { status: 400 });
  }

  const halfSpan = span / 2;
  const latDelta = halfSpan / 111320;
  const lonDelta = halfSpan / Math.max(12000, 111320 * Math.cos((lat * Math.PI) / 180));
  const bounds = {
    south: lat - latDelta,
    west: lon - lonDelta,
    north: lat + latDelta,
    east: lon + lonDelta,
  };

  try {
    const [terrain, elevation] = await Promise.all([loadVectorFeatures(bounds), loadElevation(bounds)]);
    return Response.json(
      {
        bounds,
        features: terrain.features,
        elevation,
        generated_at: new Date().toISOString(),
        osm_timestamp: null,
        vector_tile_zoom: terrain.tileZoom,
        vector_tile_count: terrain.tileCount,
        source_feature_count: terrain.sourceFeatureCount,
      },
      { headers: { "Cache-Control": "private, max-age=900" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Terrain source unavailable";
    return Response.json({ error: message }, { status: 502 });
  }
}
