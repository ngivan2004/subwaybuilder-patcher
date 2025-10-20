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

const fetchRoadDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.roads);
  const allRoads = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
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

    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Roads ${i+1}/${tiles.length} ETA:${eta}s` });
    const data = await runQueryWithRetry(roadQuery);
    // Use for loop for very large arrays (safer than spread or apply)
    for (let j = 0; j < data.elements.length; j++) {
      allRoads.push(data.elements[j]);
    }
    
    // Delay between requests with small random jitter to avoid synchronized requests
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 1000; // 0-1 second random jitter
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: 'Roads complete' });

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
    "features": allRoads.map((element) => ({
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

const fetchBuildingsDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.buildings);
  const allBuildings = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const buildingQuery = `
[out:json][timeout:180];
(
  way["building"](${tile.join(',')});
);
out geom;`;

    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Buildings ${i+1}/${tiles.length} ETA:${eta}s` });
    const data = await runQueryWithRetry(buildingQuery);
    // Use for loop for very large arrays (safer than spread or apply)
    for (let j = 0; j < data.elements.length; j++) {
      allBuildings.push(data.elements[j]);
    }
    
    // Delay between requests with small random jitter to avoid synchronized requests
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 1000; // 0-1 second random jitter
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: 'Buildings complete' });
  return allBuildings;
};

const fetchPlacesDataTiled = async (bbox, progressBar) => {
  const tiles = generateTiles(bbox, perfConfig.overpassTileSize.places);
  const allPlaces = [];
  const startTime = Date.now();
  
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
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

    const percent = Math.floor((i / tiles.length) * 100);
    const elapsed = (Date.now() - startTime) / 1000;
    const eta = i > 0 ? Math.round((elapsed / i) * (tiles.length - i)) : 0;
    progressBar.update(percent, { stage: `Places ${i+1}/${tiles.length} ETA:${eta}s` });
    const data = await runQueryWithRetry(placesQuery);
    // Use for loop for very large arrays (safer than spread or apply)
    for (let j = 0; j < data.elements.length; j++) {
      allPlaces.push(data.elements[j]);
    }
    
    // Delay between requests with small random jitter to avoid synchronized requests
    if (i < tiles.length - 1) {
      const jitter = Math.random() * 1000; // 0-1 second random jitter
      await sleep(perfConfig.requestDelay + jitter);
    }
  }
  
  progressBar.update(100, { stage: 'Places complete' });
  return allPlaces;
};

// Stream write large JSON with batching for performance
const writeJsonStream = async (filePath, data, progressBar, label) => {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }); // 1MB buffer
    
    writeStream.on('error', reject);
    writeStream.on('finish', resolve);
    
    // For arrays, stream in batches
    if (Array.isArray(data)) {
      writeStream.write('[');
      
      for (let i = 0; i < data.length; i++) {
        if (i > 0) writeStream.write(',');
        writeStream.write(JSON.stringify(data[i]));
        
        if (progressBar && i % 1000 === 0) {
          const percent = Math.floor((i / data.length) * 100);
          progressBar.update(percent, { stage: `${label} ${i.toLocaleString()}/${data.length.toLocaleString()}` });
        }
      }
      
      if (progressBar) progressBar.update(100, { stage: `${label} complete` });
      writeStream.end(']', resolve);
    } 
    // For FeatureCollections, stream features individually
    else if (data && typeof data === 'object' && data.features && Array.isArray(data.features)) {
      writeStream.write('{"type":"FeatureCollection","features":[');
      
      for (let i = 0; i < data.features.length; i++) {
        if (i > 0) writeStream.write(',');
        writeStream.write(JSON.stringify(data.features[i]));
        
        if (progressBar && i % 1000 === 0) {
          const percent = Math.floor((i / data.features.length) * 100);
          progressBar.update(percent, { stage: `${label} ${i.toLocaleString()}/${data.features.length.toLocaleString()}` });
        }
      }
      
      if (progressBar) progressBar.update(100, { stage: `${label} complete` });
      writeStream.end(']}', resolve);
    }
    // For other objects, fallback
    else {
      try {
        writeStream.end(JSON.stringify(data), resolve);
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
    // Fetch data with tiling (with delays between datasets to avoid rate limits)
    const roadData = await fetchRoadDataTiled(convertedBoundingBox, roadBar);
    
    // Wait before starting next dataset to be nice to Overpass
    if (perfConfig.datasetDelay) {
      await sleep(perfConfig.datasetDelay);
    }
    
    const buildingData = await fetchBuildingsDataTiled(convertedBoundingBox, buildingBar);
    
    // Wait before starting next dataset
    if (perfConfig.datasetDelay) {
      await sleep(perfConfig.datasetDelay);
    }
    
    const placesData = await fetchPlacesDataTiled(convertedBoundingBox, placesBar);

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
