# Error Handling and Detection Guide

## What Errors Are We Catching?

### 1. HTTP Errors (from Overpass API)

**Caught in `runQueryWithRetry`:**

```javascript
if (!res.ok) {
  throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}
```

**Common HTTP errors:**
- **429 Too Many Requests** - Rate limit hit, retry with 1s → 4s → 16s delays
- **504 Gateway Timeout** - Query took too long, retry with 1s → 2s → 4s delays  
- **503 Service Unavailable** - Overpass server overloaded, retry with exponential backoff
- **400 Bad Request** - Malformed query (shouldn't happen, indicates bug)

### 2. Network Errors

**Caught in `runQueryWithRetry` catch block:**

```javascript
} catch (error) {
  // Network failures, connection issues, DNS problems
  console.log(`Attempt ${attempt} failed: ${error.message}`);
}
```

**Common network errors:**
- `TypeError: Failed to fetch` - Network connection lost
- `ECONNRESET` - Connection reset by Overpass server
- `ETIMEDOUT` - Request timed out (different from 504)
- `ENOTFOUND` - DNS resolution failed

### 3. JSON Parsing Errors

**Caught in streaming parser:**

```javascript
parseStream.on('error', reject);
```

**Common parsing errors:**
- `Unexpected COMMA` - Malformed JSON (our bug, should be fixed now)
- `Unexpected end of JSON` - Incomplete response from server
- `Parser cannot parse input` - Invalid JSON structure

### 4. Overpass API Warnings

**Detected in response data:**

```javascript
if (parsedData && parsedData.remark) {
  console.warn(`⚠️  Overpass remark: ${parsedData.remark}`);
}
```

**Common remarks:**
- `"runtime error: Query timed out"` - Didn't finish in 180 seconds
- `"Query run out of memory"` - Query too complex/large
- Note: These come as remarks, not errors!

## The "0 Results" Problem

### When a tile returns 0 results, it could mean:

1. **Legitimate empty area** 
   - Ocean, rural farmland, desert
   - ✅ Correct behavior: Accept 0 results

2. **Overpass silent truncation**
   - Query too complex, returned partial results
   - Server timed out internally but returned 200 OK
   - Hit memory limits
   - ❌ Problem: We're missing data!

3. **Query didn't match anything**
   - Area has buildings but they don't match our tags
   - Rare for buildings, more common for specific road types
   - ✅ Correct behavior: Accept 0 results

### How We Handle This

**We can't definitively tell the difference!** So we use heuristics:

```javascript
if (data.elements.length === 0 && tileArea > 0.1) {
  // Tile is large (> 0.1 sq degrees ≈ 11km × 11km)
  // If it's a populated area, this is suspicious
  // → Split into 4 quadrants and try again
  splitAndRecurse();
}
```

**The logic:**
- Small tile (< 0.1 sq°) with 0 results → Probably legitimate, accept it
- Large tile (> 0.1 sq°) with 0 results → Suspicious, split it!

**This is conservative:** We may split some legitimate empty areas, but that's okay - the subtiles will also return 0 and eventually we'll hit the minimum size or max depth.

## Detailed Error Flow

### Success Case
```
┌─────────────────────────────────────┐
│ Try downloading tile                │
├─────────────────────────────────────┤
│ HTTP 200 OK                         │
│ Parse JSON successfully             │
│ data.elements.length = 150,234      │
└─────────────────────────────────────┘
         ↓
    Return data ✓
```

### Rate Limit Case
```
┌─────────────────────────────────────┐
│ Attempt 1: Try downloading tile     │
├─────────────────────────────────────┤
│ HTTP 429 Too Many Requests          │
└─────────────────────────────────────┘
         ↓ Wait 1 second
┌─────────────────────────────────────┐
│ Attempt 2: Retry                    │
├─────────────────────────────────────┤
│ HTTP 429 Too Many Requests          │
└─────────────────────────────────────┘
         ↓ Wait 4 seconds
┌─────────────────────────────────────┐
│ Attempt 3: Retry                    │
├─────────────────────────────────────┤
│ HTTP 200 OK                         │
│ data.elements.length = 50,123       │
└─────────────────────────────────────┘
         ↓
    Return data ✓
```

### Zero Results Case (Suspicious)
```
┌─────────────────────────────────────┐
│ Try downloading tile                │
│ [139.0, 35.0, 140.0, 36.0]         │
│ (1.0 sq degrees)                    │
├─────────────────────────────────────┤
│ HTTP 200 OK                         │
│ data.elements.length = 0            │
└─────────────────────────────────────┘
         ↓ Tile is large (> 0.1), split it
┌─────────────────────────────────────┐
│ 🔄 Splitting into 4 subtiles...     │
├─────────────────────────────────────┤
│ [139.0, 35.0, 139.5, 35.5]         │
│   → 50,234 buildings ✓              │
│ [139.5, 35.0, 140.0, 35.5]         │
│   → 48,123 buildings ✓              │
│ [139.0, 35.5, 139.5, 36.0]         │
│   → 51,890 buildings ✓              │
│ [139.5, 35.5, 140.0, 36.0]         │
│   → 49,771 buildings ✓              │
└─────────────────────────────────────┘
         ↓
    Return 200,018 buildings ✓
    (Would have been 0 without recursion!)
```

### Complete Failure Case
```
┌─────────────────────────────────────┐
│ Attempt 1: Try downloading tile     │
├─────────────────────────────────────┤
│ Network error: ETIMEDOUT            │
└─────────────────────────────────────┘
         ↓ Wait 1 second
┌─────────────────────────────────────┐
│ Attempt 2: Retry                    │
├─────────────────────────────────────┤
│ Network error: ECONNRESET           │
└─────────────────────────────────────┘
         ↓ Wait 2 seconds
┌─────────────────────────────────────┐
│ Attempt 3: Retry                    │
├─────────────────────────────────────┤
│ Network error: ETIMEDOUT            │
└─────────────────────────────────────┘
         ↓ All retries exhausted
         ↓ Tile is large (> 0.1), split it
┌─────────────────────────────────────┐
│ 🔄 FAILED: Splitting into subtiles  │
│ Try each subtile separately         │
└─────────────────────────────────────┘
```

## Log Messages You'll See

### Normal Operation
```
Roads 1/3 (5,234 found) ETA:12s
Roads 2/3 (10,892 found) ETA:6s
Roads 3/3 (15,678 found) ETA:0s
Roads complete (15,678 found)
```

### Recursive Splitting (0 results)
```
Buildings 2/8 (234,567 found) ETA:45s
🔄 Buildings: Tile [139.000, 35.000, 140.000, 36.000] (1.000 sq°) returned 0 results
   Splitting into 4 subtiles at depth 1...
   ✓ Recursive fetch recovered 198,234 buildings from subtiles
Buildings 3/8 (432,801 found) ETA:38s
```

### Error with Recovery
```
Buildings 4/8 (678,234 found) ETA:32s
Attempt 1 failed (429). Retrying in 1s...
Attempt 2 failed (429). Retrying in 4s...
🔄 Buildings: Tile [140.500, 35.500, 141.000, 36.000] (0.250 sq°) FAILED: HTTP 429: Too Many Requests
   Splitting into 4 subtiles at depth 1...
   ✓ Recursive fetch recovered 87,456 buildings from subtiles after error
Buildings 5/8 (765,690 found) ETA:28s
```

### Unrecoverable Error
```
⚠️  Buildings: Tile [141.900, 36.900, 141.910, 36.910] (0.0001 sq°) failed and too small to split: Network error
(This tile is skipped, might lose a few buildings)
```

## How to Interpret Results

### ✅ Good Signs
- No split messages → All tiles returned data on first try
- "Recursive fetch recovered X" → System caught and fixed missing data
- Final building count matches expected density for the area

### ⚠️ Warning Signs
- Many "returned 0 results" messages in dense urban areas
- "failed and too small to split" in known populated areas
- Final building count seems too low

### 🚨 Bad Signs
- Many "Attempt 3 failed" without recovery
- HTTP 503/504 errors that don't resolve
- Final building count is orders of magnitude wrong

## Verification Strategy

After download completes, check:

1. **Total count makes sense**
   ```
   Hong Kong: ~100k buildings expected
   Tokyo: ~5-6M buildings expected
   ```

2. **Download summary shows splits**
   ```
   Look for "Recursive fetch recovered" messages
   If you see these, the system is working correctly
   ```

3. **No persistent errors**
   ```
   Occasional 429 or timeout is fine (retries handle it)
   But consistent failures indicate a problem
   ```

4. **Compare with OSM data**
   ```
   Check https://www.openstreetmap.org for the area
   Zoom in and verify there are buildings where expected
   ```

