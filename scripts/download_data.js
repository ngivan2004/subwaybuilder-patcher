import fs from 'fs';
import { Readable } from "stream";
import config from '../config.js';
import perfConfig from '../performance_config.js';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import { createParseStream } from 'big-json';

const convertBbox = (bbox) => [bbox[1], bbox[0], bbox[3], bbox[2]];

// Calculate tiles for a bounding box with adaptive sizing
const generateTiles = (bbox, maxTileSize = 0.5) => {
  const [south, west, north, east] = bbox;
  const tiles = [];
  
  let lat = south;
  while (lat < north) {
    const nextLat = Math.min(lat + maxTileSize, north);
    let lon = west;
    while (lon < east) {
      const nextLon = Math.min(lon + maxTileSize, east);
      tiles.push([lat, lon, nextLat, nextLon]);
      lon = nextLon;
    }
    lat = nextLat;
  }
  
  return tiles;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Retry logic with exponential backoff
const runQueryWithRetry = async (query, maxRetries = perfConfig.retry.maxAttempts, baseDelay = perfConfig.retry.baseDelay) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    "credentials": "omit",
    "headers": {
      "User-Agent": "SubwayBuilder-Patcher (https://github.com/piemadd/subwaybuilder-patcher)",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.5"
    },
    "body": `data=${encodeURIComponent(query)}`,
    "method": "POST",
    "mode": "cors"
  });

  if (!res.ok) {
        if (attempt < maxRetries) {
          // For rate limits (429), use longer delays
          const isRateLimit = res.status === 429;
          const delay = isRateLimit 
            ? baseDelay * Math.pow(4, attempt - 1)  // 1s, 4s, 16s for rate limits
            : baseDelay * Math.pow(2, attempt - 1); // 1s, 2s, 4s for other errors
          console.log(`  Attempt ${attempt} failed (${res.status}). Retrying in ${delay/1000}s...`);
          await sleep(delay);
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Use streaming JSON parser to avoid string length limits
  const parseStream = createParseStream();
      let parsedData = null;

  parseStream.on('data', (data) => {
        parsedData = data;
  });

  await new Promise((resolve, reject) => {
    parseStream.on('end', resolve);
    parseStream.on('error', reject);
        Readable.fromWeb(res.body).pipe(parseStream);
      });
      
      // Check for Overpass API-specific errors or warnings
      if (parsedData && parsedData.remark) {
        console.warn(`  ⚠️  Overpass remark: ${parsedData.remark}`);
      }
      
      // Check if response indicates timeout or truncation
      if (parsedData && parsedData.elements && parsedData.elements.length === 0) {
        // This could be legitimate empty area OR truncated results
        // We can't tell for sure, but log it for debugging
        // (Recursive tiling will handle it)
      }
      
      return parsedData;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`  Attempt ${attempt} failed: ${error.message}. Retrying in ${delay/1000}s...`);
        await sleep(delay);
      } else {
        throw error;
      }
    }
  }
};

const getStreetName = (tags, preferLocale = 'en') => {
  if (tags.noname === 'yes') return '';
  const localized = tags[`name:${preferLocale}`];
  if (localized && localized.trim()) return localized.trim();
  if (tags.name && tags.name.trim()) return tags.name.trim();
  if (tags.ref && tags.ref.trim()) {
    return tags.ref.trim();
  }
  return '';
};

const processRoads = (elements) => {
  const roadTypes = {
    motorway: 'highway',
    trunk: 'major',
    primary: 'major',
    secondary: 'minor',
    tertiary: 'minor',
    residential: 'minor',
  };

  return {
    "type": "FeatureCollection", 
    "features": elements.map((element) => ({
        "type": "Feature",
        "properties": {
        roadClass: roadTypes[element.tags.highway],
        structure: "normal",
        name: getStreetName(element.tags, (config.locale || 'en')),
         },
            "geometry": {
            "coordinates": element.geometry.map((coord) => [coord.lon, coord.lat]),
            "type": "LineString"
       }
    }))
  };
};

// Recursive tile fetcher for roads
const fetchRoadTileRecursive = async (tile, depth = 0, maxDepth = 3) => {
  const tileArea = (tile[2] - tile[0]) * (tile[3] - tile[1]);
  
  if (depth >= maxDepth || tileArea < 0.01) {
    const roadQuery = `
[out:json][timeout:180];
(
  way["highway"="motorway"](${tile.join(',')});
  way["highway"="trunk"](${tile.join(',')});
  way["highway"="primary"](${tile.join(',')});
  way["highway"="secondary"](${tile.join(',')});
  way["highway"="tertiary"](${tile.join(',')});
  way["highway"="residential"](${tile.join(',')});
);
out geom;`;
    
    try {
      const data = await runQueryWithRetry(roadQuery);
      return data.elements || [];
    } catch (error) {
      console.warn(`  ⚠️  Road tile failed: ${error.message}`);
      return [];
    }
  }
  
  const roadQuery = `
[out:json][timeout:180];
(
  way["highway"="motorway"](${tile.join(',')});
  way["highway"="trunk"](${tile.join(',')});
  way["highway"="primary"](${tile.join(',')});
  way["highway"="secondary"](${tile.join(',')});
  way["highway"="tertiary"](${tile.join(',')});
  way["highway"="residential"](${tile.join(',')});
);
out geom;`;

  try {
    const data = await runQueryWithRetry(roadQuery);
    
    if (data.elements.length === 0 && tileArea > 0.1) {
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],
        [midLon, tile[1], tile[2], midLat],
        [tile[0], midLat, midLon, tile[3]],
        [midLon, midLat, tile[2], tile[3]],
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchRoadTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      return results;
    }
    
    return data.elements || [];
  } catch (error) {
    if (tileArea > 0.1) {
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],
        [midLon, tile[1], tile[2], midLat],
        [tile[0], midLat, midLon, tile[3]],
        [midLon, midLat, tile[2], tile[3]],
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchRoadTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      return results;
    }
    
    console.warn(`  ⚠️  Road tile failed: ${error.message}`);
    return [];
  }
};

const fetchRoadDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.roads);
  const allRoads = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    
    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Roads ${i+1}/${tiles.length} (${allRoads.length.toLocaleString()} found) ETA:${eta}s` });
    
    const tileResults = await fetchRoadTileRecursive(tile);
    
    for (let j = 0; j < tileResults.length; j++) {
      allRoads.push(tileResults[j]);
    }
    
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 500;
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: `Roads complete (${allRoads.length.toLocaleString()} found)` });
  return processRoads(allRoads);
};

const fetchRoadData = async (bbox, progressBar) => {
  // Calculate bbox area to determine if we should try full download
  const bboxArea = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const skipFullDownload = bboxArea > 1.5; // Skip if area > 1.5 sq degrees
  
  // Try full bbox first if enabled and area is reasonable
  if (perfConfig.tryFullBboxFirst && !skipFullDownload) {
    try {
      progressBar.update(0, { stage: 'Trying full area...' });
      const roadQuery = `
[out:json][timeout:180];
(
  way["highway"="motorway"](${bbox.join(',')});
  way["highway"="trunk"](${bbox.join(',')});
  way["highway"="primary"](${bbox.join(',')});
  way["highway"="secondary"](${bbox.join(',')});
  way["highway"="tertiary"](${bbox.join(',')});
  way["highway"="residential"](${bbox.join(',')});
);
out geom;`;
      
      const data = await runQueryWithRetry(roadQuery, 1); // Only try once
      
      // Check if we got suspiciously few results
      if (data.elements.length === 0) {
        progressBar.update(0, { stage: 'Got 0 results, tiling...' });
        return fetchRoadDataTiled(bbox, progressBar);
      }
      
      progressBar.update(100, { stage: `Roads complete (1 request, ${data.elements.length.toLocaleString()} found)` });
      return processRoads(data.elements);
    } catch (error) {
      // Fall back to tiling
      progressBar.update(0, { stage: 'Full area failed, tiling...' });
      return fetchRoadDataTiled(bbox, progressBar);
    }
  } else {
    // Area too large, go straight to tiling
    if (skipFullDownload) {
      progressBar.update(0, { stage: 'Large area, tiling...' });
    }
    return fetchRoadDataTiled(bbox, progressBar);
  }
};

// Recursive tile fetcher for buildings - splits tiles that return 0 or fail
const fetchBuildingTileRecursive = async (tile, depth = 0, maxDepth = 3) => {
  const tileArea = (tile[2] - tile[0]) * (tile[3] - tile[1]);
  
  // If tile is very small, don't recurse further
  if (depth >= maxDepth || tileArea < 0.01) {
    const buildingQuery = `
[out:json][timeout:180];
(
  way["building"](${tile.join(',')});
);
out geom;`;
    
    try {
      const data = await runQueryWithRetry(buildingQuery);
      return data.elements || [];
    } catch (error) {
      console.warn(`  ⚠️  Tile [${tile.map(n => n.toFixed(3)).join(', ')}] failed after retries: ${error.message}`);
      return [];
    }
  }
  
  // Try fetching this tile
  const buildingQuery = `
[out:json][timeout:180];
(
  way["building"](${tile.join(',')});
);
out geom;`;

  try {
    const data = await runQueryWithRetry(buildingQuery);
    
    // If we got 0 results and tile is large enough, split it
    if (data.elements.length === 0 && tileArea > 0.1) {
      console.log(`  🔄 Buildings: Tile [${tile.map(n => n.toFixed(3)).join(', ')}] (${tileArea.toFixed(3)} sq°) returned 0 results`);
      console.log(`     Splitting into 4 subtiles at depth ${depth + 1}...`);
      
      // Split into 4 quadrants
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],     // Bottom-left
        [midLon, tile[1], tile[2], midLat],     // Bottom-right
        [tile[0], midLat, midLon, tile[3]],     // Top-left
        [midLon, midLat, tile[2], tile[3]],     // Top-right
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchBuildingTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      console.log(`     ✓ Recursive fetch recovered ${results.length.toLocaleString()} buildings from subtiles`);
      return results;
    }
    
    return data.elements || [];
  } catch (error) {
    // If fetch failed and tile is large, try splitting
    if (tileArea > 0.1) {
      console.log(`  🔄 Buildings: Tile [${tile.map(n => n.toFixed(3)).join(', ')}] (${tileArea.toFixed(3)} sq°) FAILED: ${error.message}`);
      console.log(`     Splitting into 4 subtiles at depth ${depth + 1}...`);
      
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],
        [midLon, tile[1], tile[2], midLat],
        [tile[0], midLat, midLon, tile[3]],
        [midLon, midLat, tile[2], tile[3]],
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchBuildingTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      console.log(`     ✓ Recursive fetch recovered ${results.length.toLocaleString()} buildings from subtiles after error`);
      return results;
    }
    
    console.warn(`  ⚠️  Buildings: Tile [${tile.map(n => n.toFixed(3)).join(', ')}] (${tileArea.toFixed(3)} sq°) failed and too small to split: ${error.message}`);
    return [];
  }
};

const fetchBuildingsDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.buildings);
  const allBuildings = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    
    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Buildings ${i+1}/${tiles.length} (${allBuildings.length.toLocaleString()} found) ETA:${eta}s` });
    
    const tileResults = await fetchBuildingTileRecursive(tile);
    
    // Use for loop for very large arrays (safer than spread or apply)
    for (let j = 0; j < tileResults.length; j++) {
      allBuildings.push(tileResults[j]);
    }
    
    // Delay between requests with small random jitter to avoid synchronized requests
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 500; // 0-500ms random jitter
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: `Buildings complete (${allBuildings.length.toLocaleString()} found)` });
  return allBuildings;
};

const fetchBuildingsData = async (bbox, progressBar) => {
  // Calculate bbox area to determine if we should try full download
  const bboxArea = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const skipFullDownload = bboxArea > 1.5; // Skip if area > 1.5 sq degrees
  
  // Try full bbox first if enabled and area is reasonable
  if (perfConfig.tryFullBboxFirst && !skipFullDownload) {
    try {
      progressBar.update(0, { stage: 'Trying full area...' });
  const buildingQuery = `
[out:json][timeout:180];
(
  way["building"](${bbox.join(',')});
);
out geom;`;
      
      const data = await runQueryWithRetry(buildingQuery, 1); // Only try once
      
      // Check if we got suspiciously few results (indicates Overpass truncation)
      if (data.elements.length === 0) {
        progressBar.update(0, { stage: 'Got 0 results, tiling...' });
        return fetchBuildingsDataTiled(bbox, progressBar);
      }
      
      progressBar.update(100, { stage: `Buildings complete (1 request, ${data.elements.length.toLocaleString()} found)` });
  return data.elements;
    } catch (error) {
      // Fall back to tiling
      progressBar.update(0, { stage: 'Full area failed, tiling...' });
      return fetchBuildingsDataTiled(bbox, progressBar);
    }
  } else {
    // Area too large, go straight to tiling
    if (skipFullDownload) {
      progressBar.update(0, { stage: 'Large area, tiling...' });
    }
    return fetchBuildingsDataTiled(bbox, progressBar);
  }
};

// Recursive tile fetcher for places
const fetchPlaceTileRecursive = async (tile, depth = 0, maxDepth = 3) => {
  const tileArea = (tile[2] - tile[0]) * (tile[3] - tile[1]);
  
  if (depth >= maxDepth || tileArea < 0.01) {
    const placesQuery = `
[out:json][timeout:180];
(
  nwr["place"="neighbourhood"](${tile.join(',')});
  nwr["place"="quarter"](${tile.join(',')});
  nwr["place"="suburb"](${tile.join(',')});
  nwr["place"="hamlet"](${tile.join(',')});
  nwr["place"="village"](${tile.join(',')});
  nwr["aeroway"="terminal"](${tile.join(',')});
);
out geom;`;
    
    try {
      const data = await runQueryWithRetry(placesQuery);
      return data.elements || [];
    } catch (error) {
      console.warn(`  ⚠️  Places tile failed: ${error.message}`);
      return [];
    }
  }
  
  const placesQuery = `
[out:json][timeout:180];
(
  nwr["place"="neighbourhood"](${tile.join(',')});
  nwr["place"="quarter"](${tile.join(',')});
  nwr["place"="suburb"](${tile.join(',')});
  nwr["place"="hamlet"](${tile.join(',')});
  nwr["place"="village"](${tile.join(',')});
  nwr["aeroway"="terminal"](${tile.join(',')});
);
out geom;`;

  try {
    const data = await runQueryWithRetry(placesQuery);
    
    if (data.elements.length === 0 && tileArea > 0.1) {
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],
        [midLon, tile[1], tile[2], midLat],
        [tile[0], midLat, midLon, tile[3]],
        [midLon, midLat, tile[2], tile[3]],
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchPlaceTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      return results;
    }
    
    return data.elements || [];
  } catch (error) {
    if (tileArea > 0.1) {
      const midLon = (tile[0] + tile[2]) / 2;
      const midLat = (tile[1] + tile[3]) / 2;
      const subtiles = [
        [tile[0], tile[1], midLon, midLat],
        [midLon, tile[1], tile[2], midLat],
        [tile[0], midLat, midLon, tile[3]],
        [midLon, midLat, tile[2], tile[3]],
      ];
      
      const results = [];
      for (const subtile of subtiles) {
        const subtileResults = await fetchPlaceTileRecursive(subtile, depth + 1, maxDepth);
        for (let i = 0; i < subtileResults.length; i++) {
          results.push(subtileResults[i]);
        }
        await sleep(perfConfig.requestDelay);
      }
      return results;
    }
    
    console.warn(`  ⚠️  Places tile failed: ${error.message}`);
    return [];
  }
};

const fetchPlacesDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.places);
  const allPlaces = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    
    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Places ${i+1}/${tiles.length} (${allPlaces.length.toLocaleString()} found) ETA:${eta}s` });
    
    const tileResults = await fetchPlaceTileRecursive(tile);
    
    for (let j = 0; j < tileResults.length; j++) {
      allPlaces.push(tileResults[j]);
    }
    
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 500;
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: `Places complete (${allPlaces.length.toLocaleString()} found)` });
  return allPlaces;
};

const fetchPlacesData = async (bbox, progressBar) => {
  // Calculate bbox area to determine if we should try full download
  const bboxArea = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  const skipFullDownload = bboxArea > 1.5; // Skip if area > 1.5 sq degrees
  
  // Try full bbox first if enabled and area is reasonable
  if (perfConfig.tryFullBboxFirst && !skipFullDownload) {
    try {
      progressBar.update(0, { stage: 'Trying full area...' });
      const placesQuery = `
[out:json][timeout:180];
(
  nwr["place"="neighbourhood"](${bbox.join(',')});
  nwr["place"="quarter"](${bbox.join(',')});
  nwr["place"="suburb"](${bbox.join(',')});
  nwr["place"="hamlet"](${bbox.join(',')});
  nwr["place"="village"](${bbox.join(',')});
  nwr["aeroway"="terminal"](${bbox.join(',')});
);
out geom;`;
      
      const data = await runQueryWithRetry(placesQuery, 1); // Only try once
      
      // Check if we got suspiciously few results
      if (data.elements.length === 0) {
        progressBar.update(0, { stage: 'Got 0 results, tiling...' });
        return fetchPlacesDataTiled(bbox, progressBar);
      }
      
      progressBar.update(100, { stage: `Places complete (1 request, ${data.elements.length.toLocaleString()} found)` });
  return data.elements;
    } catch (error) {
      // Fall back to tiling
      progressBar.update(0, { stage: 'Full area failed, tiling...' });
      return fetchPlacesDataTiled(bbox, progressBar);
    }
  } else {
    // Area too large, go straight to tiling
    if (skipFullDownload) {
      progressBar.update(0, { stage: 'Large area, tiling...' });
    }
    return fetchPlacesDataTiled(bbox, progressBar);
  }
};

// Stream write large JSON with batching for performance
const writeJsonStream = async (filePath, data, progressBar, label) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }); // 1MB buffer
    
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    
    // Helper to handle backpressure properly
    const writeWithBackpressure = (chunk) => {
      return new Promise((resolveWrite) => {
        if (!writeStream.write(chunk)) {
          writeStream.once('drain', resolveWrite);
        } else {
          resolveWrite();
        }
      });
    };
    
    // For arrays, stream element by element with backpressure handling
    if (Array.isArray(data)) {
      (async () => {
        try {
          await writeWithBackpressure('[');
          
          for (let i = 0; i < data.length; i++) {
            if (i > 0) await writeWithBackpressure(',');
            await writeWithBackpressure(JSON.stringify(data[i]));
            
            if (progressBar && i % 1000 === 0) {
              const percent = Math.floor((i / data.length) * 100);
              progressBar.update(percent, { stage: `${label} ${i.toLocaleString()}/${data.length.toLocaleString()}` });
            }
          }
          
          if (progressBar) progressBar.update(100, { stage: `${label} complete` });
          writeStream.end(']');
        } catch (err) {
          reject(err);
        }
      })();
    } 
    // For FeatureCollections, stream features individually
    else if (data && typeof data === 'object' && data.features && Array.isArray(data.features)) {
      (async () => {
        try {
          await writeWithBackpressure('{"type":"FeatureCollection","features":[');
          
          for (let i = 0; i < data.features.length; i++) {
            if (i > 0) await writeWithBackpressure(',');
            await writeWithBackpressure(JSON.stringify(data.features[i]));
            
            if (progressBar && i % 1000 === 0) {
              const percent = Math.floor((i / data.features.length) * 100);
              progressBar.update(percent, { stage: `${label} ${i.toLocaleString()}/${data.features.length.toLocaleString()}` });
            }
          }
          
          if (progressBar) progressBar.update(100, { stage: `${label} complete` });
          writeStream.end(']}');
        } catch (err) {
          reject(err);
        }
      })();
    }
    // For other objects, fallback
    else {
      try {
        writeStream.end(JSON.stringify(data));
      } catch (error) {
        reject(error);
      }
    }
  });
};

const fetchAllData = async (place) => {
  if (!fs.existsSync(`./raw_data/${place.code}`)) {
    fs.mkdirSync(`./raw_data/${place.code}`, { recursive: true });
  }

  console.log(`\nFetching ${place.name} (${place.code})`);
  const convertedBoundingBox = convertBbox(place.bbox);
  
  // Create progress bars
  const multibar = new cliProgress.MultiBar({
    clearOnComplete: false,
    hideCursor: true,
    format: ' {stage} | {bar} | {percentage}%',
  }, cliProgress.Presets.shades_classic);

  const roadBar = multibar.create(100, 0, { stage: 'Roads' });
  const buildingBar = multibar.create(100, 0, { stage: 'Buildings' });
  const placesBar = multibar.create(100, 0, { stage: 'Places' });

  try {
    // Fetch data (tries full bbox first, tiles if needed, with delays between datasets to avoid rate limits)
    const roadData = await fetchRoadData(convertedBoundingBox, roadBar);
    
    // Wait before starting next dataset to be nice to Overpass
    if (perfConfig.datasetDelay) {
      await sleep(perfConfig.datasetDelay);
    }
    
    const buildingData = await fetchBuildingsData(convertedBoundingBox, buildingBar);
    
    // Wait before starting next dataset
    if (perfConfig.datasetDelay) {
      await sleep(perfConfig.datasetDelay);
    }
    
    const placesData = await fetchPlacesData(convertedBoundingBox, placesBar);

    console.log(`\n  Writing ${roadData.features.length.toLocaleString()} roads, ${buildingData.length.toLocaleString()} buildings, ${placesData.length.toLocaleString()} places to disk...\n`);

    // Reuse progress bars for writing
    roadBar.update(0, { stage: 'Writing roads' });
    await writeJsonStream(`./raw_data/${place.code}/roads.geojson`, roadData, roadBar, 'Roads');
    
    buildingBar.update(0, { stage: 'Writing buildings' });
    await writeJsonStream(`./raw_data/${place.code}/buildings.json`, buildingData, buildingBar, 'Buildings');
    
    placesBar.update(0, { stage: 'Writing places' });
    await writeJsonStream(`./raw_data/${place.code}/places.json`, placesData, placesBar, 'Places');

    multibar.stop();
    
    console.log(`\n  📊 Download Summary for ${place.name}:`);
    console.log(`    Roads:      ${roadData.features.length.toLocaleString()} features`);
    console.log(`    Buildings:  ${buildingData.length.toLocaleString()} features`);
    console.log(`    Places:     ${placesData.length.toLocaleString()} features`);
    console.log(`    Total:      ${(roadData.features.length + buildingData.length + placesData.length).toLocaleString()} features\n`);
    
    console.log(`✓ Completed ${place.name} (${place.code})`);
  } catch (error) {
    multibar.stop();
    console.error(`\n✗ Error fetching ${place.name} (${place.code}):`, error.message);
    throw error;
  }
};

// Main execution
if (!fs.existsSync('./raw_data')) fs.mkdirSync('./raw_data');

// Process places sequentially to avoid overwhelming Overpass
const limit = pLimit(perfConfig.maxConcurrentDownloads);

const tasks = config.places.map(place => 
  limit(() => fetchAllData(place))
);

Promise.all(tasks)
  .then(() => {
    console.log('\n' + '='.repeat(60));
    console.log('✓ All downloads complete!');
    console.log(`  Processed ${config.places.length} place(s)`);
    console.log('='.repeat(60) + '\n');
  })
  .catch((error) => {
    console.error('\n✗ Download failed:', error);
    process.exit(1);
  });
