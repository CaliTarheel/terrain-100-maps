export const BASE_BOARD_WIDTH_METERS = 2200;
export const BASE_BOARD_HEIGHT_METERS = 1300;
export const BASE_BOARD_HEX_COLUMNS = 22;
export const BASE_BOARD_HEX_ROWS = 13;
export const MAX_BOARD_LAYOUT = 4;

export function clampBoardCount(value: number) {
  return Math.max(1, Math.min(MAX_BOARD_LAYOUT, Math.round(value || 1)));
}

export function boardFootprint(boardCols = 1, boardRows = 1) {
  const cols = clampBoardCount(boardCols);
  const rows = clampBoardCount(boardRows);
  const widthMeters = BASE_BOARD_WIDTH_METERS * cols;
  const heightMeters = BASE_BOARD_HEIGHT_METERS * rows;
  return {
    boardCols: cols,
    boardRows: rows,
    boardCount: cols * rows,
    widthMeters,
    heightMeters,
    totalHexColumns: BASE_BOARD_HEX_COLUMNS * cols,
    totalHexRows: BASE_BOARD_HEX_ROWS * rows,
    aspectRatio: widthMeters / heightMeters,
    requestSpanMeters: Math.ceil(Math.hypot(widthMeters, heightMeters) * 1.08),
  };
}

export function zoomForBoardFootprint(latitude: number, widthMeters: number, heightMeters: number) {
  const requiredMetersPerPixel = Math.max(widthMeters / 900, heightMeters / 520);
  const zoom = Math.log2(
    (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / Math.max(requiredMetersPerPixel, 0.01),
  );
  return Math.max(12, Math.min(17, Math.round(zoom * 10) / 10));
}
