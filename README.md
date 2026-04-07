# netflow-viz

A browser-based tool to explore directed community flow networks. No server, no install — just open the page and upload your CSVs.

## What it does

Takes two CSV files and builds an interactive graph:
- **Flow CSV** — edges between communities with interaction counts
- **Members CSV** — top handles per community (optional)

You can drag nodes around, zoom in, filter edges by count or direction, compare two communities side by side, and find the strongest path between any two communities.

## CSV format

**Flow CSV**
```
source_community, target_community, edge_count
```

**Members CSV**
```
community_id, username, display_name, pagerank, in_degree, out_degree
```

## Usage

Open [the live tool](https://mohammadfalhaa.github.io/netflow-viz), upload your files, done.

Or clone and open `index.html` directly in a browser — no build step needed.

## Features

- Zoom, pan, drag nodes
- Edge threshold slider — hide low-count edges
- Direction filter — show only outgoing or incoming edges
- Community count slider — focus on the most active communities
- Click a node — see stats and top handles
- Shift+click two nodes — compare them and find the strongest flow path
- Export as PNG
- Data stays in your browser, nothing is sent anywhere
