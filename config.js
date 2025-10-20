const config = {
  "subwaybuilderLocation": "/Applications/Subway Builder.app", // appimage location image on linux, .app location on mac or install directory on windows (something like C:\Users\[username]\AppData\Local\Programs\Subway Builder)
  "places": [
    {
      "code": "HKG",
      "name": "Hong Kong",
      "description": "The international financial centre.",
      "bbox": [113.830633,22.152769,114.386816,22.510991],
      "population": 7500000,
     },
    {
      "code": "TYO",
      "name": "Tokyo",
      "description": "Place, Japan.",
      "bbox": [139.191917,34.840084,140.979942,36.106052],
    }
  ],
  "platform": "macos" // either 'linux' or 'windows' or 'macos'
};

export default config;