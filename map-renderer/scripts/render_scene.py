"""Render cached WGS84 geography into a reusable, illustrated isometric map.

Only Pillow is required. No network requests, API keys, or map SDK at render time.
Building outlines are geographic data; missing heights and decorative windows are art.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

PALETTE = {
    'ground': '#243748', 'block': '#304557', 'park': '#34564b',
    'water': '#23566b', 'road_edge': '#4c6171', 'road': '#7d807b',
    'pedestrian': '#e1b780', 'path': '#aa967b', 'ink': '#172d40',
}
ROOFS = ['#6c8b98', '#7f9195', '#928987', '#7b929e', '#829e91', '#a18e85']


def rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def shade(color, factor):
    return tuple(max(0, min(255, int(c * factor))) for c in rgb(color))


def load_font(size, bold=False):
    candidates = [
        Path('C:/Windows/Fonts/msyhbd.ttc' if bold else 'C:/Windows/Fonts/msyh.ttc'),
        Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'),
        Path('/System/Library/Fonts/PingFang.ttc'),
    ]
    for path in candidates:
        if path.exists():
            return ImageFont.truetype(str(path), size)
    return ImageFont.load_default(size=size)


class Projection:
    """One projection shared by geometry and exported interaction hotspots."""

    def __init__(self, bbox, width, height, azimuth=25, tilt=0.62):
        self.bbox, self.width, self.height = bbox, width, height
        self.lon = (bbox[0] + bbox[2]) / 2
        self.lat = (bbox[1] + bbox[3]) / 2
        self.cos_lat = math.cos(math.radians(self.lat))
        self.cos, self.sin = math.cos(math.radians(azimuth)), math.sin(math.radians(azimuth))
        self.tilt = tilt
        corners = [self.local(lon, lat) for lon, lat in [
            (bbox[0], bbox[1]), (bbox[0], bbox[3]),
            (bbox[2], bbox[1]), (bbox[2], bbox[3]),
        ]]
        rotated = [self.rotate(x, y) for x, y in corners]
        span_x = max(x for x, y in rotated) - min(x for x, y in rotated)
        span_y = max(y for x, y in rotated) - min(y for x, y in rotated)
        self.scale = min(width * 0.90 / span_x, height * 0.78 / span_y)
        self.origin = (width / 2, height * 0.56)

    def local(self, lon, lat):
        return ((lon - self.lon) * 111320 * self.cos_lat, (lat - self.lat) * 111320)

    def rotate(self, x, y):
        return (self.cos * x + self.sin * y, (self.sin * x - self.cos * y) * self.tilt)

    def point(self, coordinate, z=0):
        x, y = self.rotate(*self.local(coordinate[0], coordinate[1]))
        return (self.origin[0] + x * self.scale, self.origin[1] + (y - z * 0.88) * self.scale)

    def contains(self, coordinate):
        return self.bbox[0] <= coordinate[0] <= self.bbox[2] and self.bbox[1] <= coordinate[1] <= self.bbox[3]


def polygons(geometry):
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    return []


def lines(geometry):
    if geometry['type'] == 'LineString':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiLineString':
        return geometry['coordinates']
    return []


def polygon_mask(size, rings, projection, z=0):
    mask = Image.new('L', size)
    pen = ImageDraw.Draw(mask)
    for i, ring in enumerate(rings):
        points = [projection.point(p, z) for p in ring]
        if len(points) >= 3:
            pen.polygon(points, fill=255 if i == 0 else 0)
    return mask


def height_for(properties):
    value = properties.get('height_m')
    if isinstance(value, (float, int)) and math.isfinite(value) and value > 0:
        return min(value, 300), properties.get('height_source') or 'source'
    # A consistent visual estimate, not a claim about the real building height.
    return 12.0, 'visual_estimate'


def road_width(properties):
    tags = properties.get('tags', {})
    kind = tags.get('highway', '')
    widths = {'motorway': 23, 'trunk': 21, 'primary': 18, 'secondary': 14,
              'tertiary': 10, 'residential': 7, 'service': 4,
              'pedestrian': 13, 'footway': 3, 'path': 2, 'steps': 3}
    try:
        width = float(str(tags.get('width', '')).split(';')[0].replace('m', '').strip())
        if 0 < width < 100:
            return width
    except ValueError:
        pass
    return widths.get(kind, 6)


def draw_building(image, rings, properties, projection):
    pen = ImageDraw.Draw(image)
    height, source = height_for(properties)
    seed = str(properties.get('osm_id', properties.get('name', rings[0][0])))
    digest = hashlib.sha256(seed.encode()).digest()
    color = ROOFS[digest[0] % len(ROOFS)]
    ring = rings[0]
    edges = list(zip(ring, ring[1:] + ring[:1]))
    # Painter order for facades; roof is drawn after sides.
    edges.sort(key=lambda edge: sum(projection.point(p)[1] for p in edge))
    for a, b in edges:
        if a == b:
            continue
        bottom_a, bottom_b = projection.point(a), projection.point(b)
        top_a, top_b = projection.point(a, height), projection.point(b, height)
        brightness = 0.70 if bottom_b[0] > bottom_a[0] else 0.52
        pen.polygon([bottom_a, bottom_b, top_b, top_a], fill=shade(color, brightness))
        pen.line([bottom_a, top_a, top_b], fill=shade(color, 0.85), width=max(1, round(projection.scale * 0.6)))
        edge_length = math.dist(projection.local(*a[:2]), projection.local(*b[:2]))
        columns = min(24, int(edge_length / 5))
        floors = min(24, int(height / 4))
        if columns > 1 and floors > 1:
            for floor in range(1, floors):
                for column in range(1, columns):
                    if (column + floor + digest[1]) % 5 == 0:
                        continue
                    t, level = column / columns, height * floor / floors
                    p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                    q = projection.point(p, level)
                    r = max(1, projection.scale * 0.55)
                    pen.rectangle([q[0] - r, q[1] - r * 0.8, q[0] + r, q[1] + r * 0.8], fill='#d6b47b')
    roof_mask = polygon_mask(image.size, rings, projection, height)
    image.paste(rgb(color), (0, 0), roof_mask)
    pen = ImageDraw.Draw(image)
    for roof_ring in rings:
        pen.line([projection.point(p, height) for p in roof_ring], fill=shade(color, 1.22), width=max(1, round(projection.scale * 0.7)))
    return source


def render_scene(scene, output, width=1800, height=2000, azimuth=25, bake_labels=True):
    bbox = scene.get('metadata', {}).get('requested_bbox_wgs84') or scene.get('bbox')
    if not bbox or len(bbox) != 4 or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ValueError('GeoJSON requires a valid [west, south, east, north] WGS84 bbox')
    features = scene.get('features', [])
    buildings = [f for f in features if f['properties'].get('kind') == 'building' and polygons(f['geometry'])]
    roads = [f for f in features if f['properties'].get('kind') == 'road' and lines(f['geometry'])]
    if not buildings or not roads:
        raise ValueError('Real road and building geometry are both required; no map will be fabricated.')
    output.mkdir(parents=True, exist_ok=True)
    projection = Projection(bbox, width, height, azimuth)
    image = Image.new('RGB', (width, height), PALETTE['ground'])
    for feature in features:
        kind, geometry = feature['properties'].get('kind'), feature['geometry']
        if kind not in ('landuse', 'water'):
            continue
        tags = feature['properties'].get('tags', {})
        green = tags.get('leisure') in ('park', 'garden') or tags.get('landuse') in ('forest', 'grass', 'recreation_ground', 'meadow')
        color = PALETTE['water'] if kind == 'water' else PALETTE['park'] if green else PALETTE['block']
        for rings in polygons(geometry):
            image.paste(rgb(color), (0, 0), polygon_mask(image.size, rings, projection))
    glow = Image.new('RGBA', image.size)
    glow_pen = ImageDraw.Draw(glow)
    pen = ImageDraw.Draw(image)
    for feature in sorted(roads, key=lambda f: -road_width(f['properties'])):
        props = feature['properties']
        road_kind = props.get('tags', {}).get('highway')
        walking = road_kind in ('pedestrian', 'footway', 'path', 'steps')
        color = PALETTE['pedestrian'] if road_kind == 'pedestrian' else PALETTE['path'] if walking else PALETTE['road']
        pixels = max(2, round(road_width(props) * projection.scale))
        for coordinates in lines(feature['geometry']):
            points = [projection.point(p) for p in coordinates]
            if len(points) < 2:
                continue
            pen.line(points, fill=PALETTE['road_edge'], width=pixels + max(2, round(projection.scale * 1.5)), joint='curve')
            pen.line(points, fill=color, width=pixels, joint='curve')
            if road_kind == 'pedestrian':
                glow_pen.line(points, fill=(255, 190, 96, 110), width=pixels + 6, joint='curve')
    image = Image.alpha_composite(image.convert('RGBA'), glow.filter(ImageFilter.GaussianBlur(9))).convert('RGB')
    shadow = Image.new('RGBA', image.size)
    shadow_pen = ImageDraw.Draw(shadow)
    entries = []
    for feature in buildings:
        for rings in polygons(feature['geometry']):
            if not rings or len(rings[0]) < 4:
                continue
            # Skip wholly out-of-frame polygons included by intersecting OSM ways.
            ground = [projection.point(p) for p in rings[0]]
            if max(p[0] for p in ground) < 0 or min(p[0] for p in ground) > width or max(p[1] for p in ground) < 0 or min(p[1] for p in ground) > height:
                continue
            h, _ = height_for(feature['properties'])
            shifted = [(x + h * projection.scale * 0.5, y + h * projection.scale * 0.20) for x, y in ground]
            shadow_pen.polygon(shifted, fill=(7, 20, 33, 155))
            entries.append((max(p[1] for p in ground), rings, feature['properties']))
    image = Image.alpha_composite(image.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(4))).convert('RGB')
    height_sources = {}
    for _, rings, props in sorted(entries, key=lambda entry: entry[0]):
        source = draw_building(image, rings, props, projection)
        height_sources[source] = height_sources.get(source, 0) + 1
    hotspots = []
    seen = set()
    pois = [f for f in features if f['properties'].get('kind') == 'poi' and f['geometry']['type'] == 'Point']
    pois.sort(key=lambda f: (f['properties'].get('source') != 'Baidu Place API', len(f['properties'].get('name', ''))))
    pen, font = ImageDraw.Draw(image), load_font(max(14, round(width / 85)), True)
    label_boxes = []
    for feature in pois:
        props, coordinate = feature['properties'], feature['geometry']['coordinates']
        name = props.get('name', '')
        if not name or name in seen or not projection.contains(coordinate):
            continue
        seen.add(name)
        x, y = projection.point(coordinate)
        hotspot = {'id': str(props.get('uid') or props.get('osm_id') or name), 'name': name,
                   'source': props.get('source'), 'coordinate': coordinate, 'coordinateSystem': 'WGS84',
                   'pixel': [round(x, 2), round(y, 2)], 'normalized': [round(x / width, 6), round(y / height, 6)]}
        hotspots.append(hotspot)
        if not bake_labels or len(label_boxes) >= 8:
            continue
        text_box = pen.textbbox((0, 0), name, font=font)
        tw, th = text_box[2] - text_box[0], text_box[3] - text_box[1]
        left = max(12, min(width - tw - 42, x - tw / 2 - 18))
        top = max(12, min(height - th - 90, y - th - 42))
        box = (left, top, left + tw + 36, top + th + 22)
        if any(not (box[2] + 8 < old[0] or box[0] > old[2] + 8 or box[3] + 8 < old[1] or box[1] > old[3] + 8) for old in label_boxes):
            continue
        label_boxes.append(box)
        pen.line([(x, y), (x, box[3])], fill='#f5c57e', width=3)
        pen.ellipse([x - 5, y - 5, x + 5, y + 5], fill='#ffe3a7', outline='#c58752', width=2)
        pen.rounded_rectangle(box, radius=8, fill='#f7e7ce', outline='#d8ad74', width=2)
        pen.text((left + 18, top + 8 - text_box[1]), name, font=font, fill='#34404b')
        hotspot['bakedLabelBounds'] = list(box)
    small = load_font(max(13, round(width / 110)))
    pen.rectangle([0, height - 62, width, height], fill='#1b2c3b')
    attribution = '© OpenStreetMap contributors | 地点：百度地图' if any(f['properties'].get('source') == 'Baidu Place API' for f in pois) else '© OpenStreetMap contributors'
    pen.text((24, height - 52), attribution, font=small, fill='#c8d6d9')
    pen.text((24, height - 29), '地理轮廓数据快照 · 无高度数据的楼宇按 12m 估算 · 窗灯为美术效果', font=small, fill='#92a6b1')
    image.save(output / 'chunxi-map.png', optimize=True)
    image.save(output / 'chunxi-map.webp', quality=92, method=6)
    hotspot_data = {'image': 'chunxi-map.png', 'width': width, 'height': height, 'coordinateSystem': 'WGS84', 'hotspots': hotspots}
    (output / 'chunxi-map.hotspots.json').write_text(json.dumps(hotspot_data, ensure_ascii=False, indent=2), encoding='utf-8')
    report = {'image': 'chunxi-map.png', 'width': width, 'height': height, 'bbox': bbox,
              'coordinateSystem': 'WGS84', 'buildings': len(entries), 'roads': len(roads),
              'hotspots': len(hotspots), 'buildingHeightSources': height_sources,
              'camera': {'projection': 'orthographic', 'azimuthDegrees': azimuth, 'groundVerticalScale': projection.tilt},
              'notes': ['Geometry is a cached geographic snapshot, not a live feed.',
                        'Building height fallback, facade windows, lighting, and colors are artistic.',
                        'This renderer does not reproduce landmark architecture or claim photorealism.']}
    (output / 'render.manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scene', type=Path, default=Path(__file__).resolve().parents[1] / 'output/scene.geojson')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'output')
    parser.add_argument('--width', type=int, default=1800)
    parser.add_argument('--height', type=int, default=2000)
    parser.add_argument('--azimuth', type=float, default=25)
    parser.add_argument('--no-labels', action='store_true')
    args = parser.parse_args()
    if not (256 <= args.width <= 8192 and 256 <= args.height <= 8192):
        parser.error('Image dimensions must be between 256 and 8192 pixels')
    try:
        scene = json.loads(args.scene.read_text(encoding='utf-8'))
        report = render_scene(scene, args.output, args.width, args.height, args.azimuth, not args.no_labels)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f'Render failed: {exc}\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
