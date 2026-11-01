"""Render a bounded game board from the existing geography. No network / AI calls.

Decorative trees, shop lights and characters are illustrative, not geographic facts.
The original data and original render are preserved in output/; this writes output/game/.
"""
import argparse
import hashlib
import heapq
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from render_scene import Projection, height_for, lines, load_font, polygons, road_width, polygon_mask


def display_height(props):
    height, _ = height_for(props)
    # A cartographic height scale keeps the street and small shops visible.
    return height if height < 28 else 28 + (height - 28) * .29


class BoardProjection(Projection):
    def __init__(self, bbox, width, height, buildings, azimuth=25):
        super().__init__(bbox, width, height, azimuth, tilt=.76)
        corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
        points = [self.rotate(*self.local(*p)) for p in corners]
        for feature in buildings:
            h = display_height(feature['properties'])
            for rings in polygons(feature['geometry']):
                for p in rings[0]:
                    if self.contains(p):
                        x, y = self.rotate(*self.local(*p))
                        points.append((x, y - h * .88))
        lo_x, hi_x = min(p[0] for p in points), max(p[0] for p in points)
        lo_y, hi_y = min(p[1] for p in points), max(p[1] for p in points)
        self.scale = min(width * .91 / (hi_x - lo_x), height * .86 / (hi_y - lo_y))
        self.origin = (width / 2 - (lo_x + hi_x) / 2 * self.scale,
                       height * .46 - (lo_y + hi_y) / 2 * self.scale)


def mix(color, factor):
    return tuple(max(0, min(255, round(c * factor))) for c in color)


def segment_points(points, spacing):
    for a, b in zip(points, points[1:]):
        length = math.dist(a, b)
        for step in range(max(0, int(length / spacing))):
            t = (step + .5) * spacing / length
            yield (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), (a, b)


def draw_tree(pen, x, y, size, rng):
    pen.ellipse((x - size * .8, y - size * .15, x + size, y + size * .45), fill='#102d3c')
    pen.line([(x, y), (x, y - size * .9)], fill='#957354', width=max(2, round(size * .16)))
    for dx, dy, r in [(-.36, -.94, .52), (.37, -.96, .55), (0, -1.47, .56)]:
        sx, sy = x + size * dx, y + size * dy
        color = rng.choice(['#327c69', '#3b8966', '#28675a', '#4c946a'])
        pen.ellipse((sx - size * r, sy - size * r, sx + size * r, sy + size * r), fill=color, outline='#173f47', width=1)
        pen.arc((sx - size * r * .8, sy - size * r * .8, sx + size * r * .6, sy + size * r * .6), 190, 285, fill='#6ead7c', width=2)


def draw_building(image, light, rings, props, projection):
    pen, glow = ImageDraw.Draw(image), ImageDraw.Draw(light)
    digest = hashlib.sha256(str(props.get('osm_id', rings[0][0])).encode()).digest()
    height = display_height(props)
    palettes = [(81, 111, 139), (106, 121, 145), (124, 120, 141), (88, 127, 138), (144, 126, 133)]
    roof = palettes[digest[0] % len(palettes)]
    ring = rings[0]
    edges = sorted(zip(ring, ring[1:] + ring[:1]), key=lambda ab: sum(projection.point(p)[1] for p in ab))
    for a, b in edges:
        if a == b:
            continue
        pa, pb = projection.point(a), projection.point(b)
        ta, tb = projection.point(a, height), projection.point(b, height)
        pen.polygon([pa, pb, tb, ta], fill=mix(roof, .60 if pb[0] > pa[0] else .39))
        pen.line([pa, ta, tb], fill=mix(roof, .92), width=2)
        span = math.dist(projection.local(*a[:2]), projection.local(*b[:2]))
        cols, floors = min(45, int(span / 3.8)), min(22, max(1, int(height / 3.4)))
        for level in range(1, floors + 1):
            for col in range(1, cols):
                if (level + col + digest[1]) % 7 == 0:
                    continue
                t = col / cols
                coord = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
                x, y = projection.point(coord, height * level / (floors + 1))
                r = max(1.2, projection.scale * .72)
                color = ['#ffda8c', '#ffd06d', '#a8d8ed', '#f6ab80'][(col // 4 + digest[2]) % 4]
                pen.rectangle((x - r, y - r * 1.5, x + r, y + r * 1.5), fill=color)
                if level < 3:
                    glow.ellipse((x - r * 3, y - r * 3, x + r * 3, y + r * 3), fill=(255, 180, 79, 55))
        # Shop-front light strip, divided into alternating awnings on low buildings.
        if span > 9:
            pen.line([projection.point(a, min(3, height / 3)), projection.point(b, min(3, height / 3))], fill='#f8cb80', width=max(2, round(projection.scale * 1.0)))
            glow.line([pa, pb], fill=(255, 176, 67, 95), width=max(4, round(projection.scale * 4)))
    mask = polygon_mask(image.size, rings, projection, height)
    image.paste(roof, (0, 0), mask)
    pen = ImageDraw.Draw(image)
    for roof_ring in rings:
        pts = [projection.point(p, height) for p in roof_ring]
        pen.line(pts, fill=mix(roof, 1.36), width=max(2, round(projection.scale * 1.0)), joint='curve')
    return height


def draw_panda(pen, x, y, scale):
    """A code-drawn illustrative mascot, placed on the geographic IFS roof."""
    def ellipse(box, fill):
        pen.ellipse(tuple(v * scale + (x if i % 2 == 0 else y) for i, v in enumerate(box)), fill=fill)
    ellipse((-22, -38, 24, 9), '#f5f0dc')
    ellipse((-24, -12, -6, 18), '#12283d')
    ellipse((10, -12, 28, 18), '#12283d')
    ellipse((-27, -63, -9, -45), '#12283d')
    ellipse((10, -63, 28, -45), '#12283d')
    ellipse((-24, -59, 25, -18), '#fff6e5')
    ellipse((-15, -48, -2, -32), '#1d3448')
    ellipse((6, -48, 18, -32), '#1d3448')
    ellipse((-10, -43, -6, -39), '#fffaf0')
    ellipse((10, -43, 14, -39), '#fffaf0')
    ellipse((-2, -33, 6, -27), '#1d3448')
    ellipse((-35, -29, -12, -10), '#1d3448')


def walking_preview(features, projection):
    """A continuous route using actual connected pedestrian line segments only."""
    graph, coordinates, starts, ends = {}, {}, [], []
    for f in features:
        props = f['properties']
        if props.get('kind') != 'road' or props.get('tags', {}).get('highway') not in ('pedestrian', 'footway', 'path', 'steps'):
            continue
        if props.get('tags', {}).get('access') in ('no', 'private'):
            continue
        for line in lines(f['geometry']):
            for a, b in zip(line, line[1:]):
                if not projection.contains(a) or not projection.contains(b):
                    continue
                ka, kb = tuple(a[:2]), tuple(b[:2])
                coordinates[ka], coordinates[kb] = a[:2], b[:2]
                distance = math.dist(projection.local(*ka), projection.local(*kb))
                graph.setdefault(ka, []).append((kb, distance))
                graph.setdefault(kb, []).append((ka, distance))
                if props.get('name') == '春熙路':
                    starts.extend([ka, kb])
                if props.get('name') == '春熙路东段':
                    ends.extend([ka, kb])
    if not starts or not ends:
        return {'available': False, 'reason': 'No connected Chunxi pedestrian route in this snapshot'}
    start, end = max(starts, key=lambda p: p[1]), max(ends, key=lambda p: p[0])
    queue, distances, previous = [(0, start)], {start: 0}, {}
    while queue:
        distance, node = heapq.heappop(queue)
        if node == end:
            break
        if distance > distances[node]:
            continue
        for neighbor, cost in graph[node]:
            candidate = distance + cost
            if candidate < distances.get(neighbor, float('inf')):
                distances[neighbor], previous[neighbor] = candidate, node
                heapq.heappush(queue, (candidate, neighbor))
    if end not in distances:
        return {'available': False, 'reason': 'Pedestrian ways are disconnected in the source'}
    path = [end]
    while path[-1] != start:
        path.append(previous[path[-1]])
    path.reverse()
    return {'available': True, 'name': '春熙路 → 春熙路东段', 'source': 'OpenStreetMap pedestrian ways',
            'coordinateSystem': 'WGS84', 'coordinates': path,
            'pixels': [[round(v, 2) for v in projection.point(p)] for p in path],
            'distanceMeters': round(distances[end]), 'note': 'Cached pedestrian geometry preview, not turn-by-turn navigation'}


def render_board(scene, output, width=2200, height=2100):
    bbox = scene.get('metadata', {}).get('requested_bbox_wgs84') or scene.get('bbox')
    if not bbox or len(bbox) != 4 or bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
        raise ValueError('A valid WGS84 scene boundary is required')
    features = scene.get('features', [])
    buildings = [f for f in features if f['properties'].get('kind') == 'building' and polygons(f['geometry'])]
    roads = [f for f in features if f['properties'].get('kind') == 'road' and lines(f['geometry'])]
    if not roads or not buildings:
        raise ValueError('Real road and building geometry are both required')
    projection = BoardProjection(bbox, width, height, buildings)
    image = Image.new('RGB', (width, height), '#0c1d31')
    pen = ImageDraw.Draw(image)
    # An island edge makes the limited playable chapter explicit.
    corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
    boundary = [projection.point(p) for p in corners]
    drop = 22 * projection.scale
    pen.polygon([(x, y + drop) for x, y in boundary], fill='#15293f')
    pen.polygon(boundary, fill='#203e50', outline='#54736d', width=3)
    clip = Image.new('L', image.size)
    ImageDraw.Draw(clip).polygon(boundary, fill=255)
    layer = image.copy()
    for f in features:
        kind, tags = f['properties'].get('kind'), f['properties'].get('tags', {})
        if kind not in ('landuse', 'water'):
            continue
        green = tags.get('leisure') in ('park', 'garden') or tags.get('landuse') in ('grass', 'forest')
        color = '#25596c' if kind == 'water' else '#295647' if green else '#2d4558'
        for rings in polygons(f['geometry']):
            layer.paste(color, (0, 0), polygon_mask(image.size, rings, projection))
    pen = ImageDraw.Draw(layer)
    road_glow = Image.new('RGBA', image.size)
    gpen = ImageDraw.Draw(road_glow)
    trees, people = [], []
    rng = random.Random(706)
    for f in sorted(roads, key=lambda f: -road_width(f['properties'])):
        props = f['properties']
        kind = props.get('tags', {}).get('highway', '')
        walking = kind in ('pedestrian', 'footway', 'path', 'steps')
        pixels = max(3, round(road_width(props) * projection.scale * (1.25 if walking else 1)))
        for coordinates in lines(f['geometry']):
            if len(coordinates) < 2:
                continue
            pts = [projection.point(p) for p in coordinates]
            pen.line(pts, fill='#709194' if walking else '#647386', width=pixels + max(4, round(projection.scale * 3)), joint='curve')
            pen.line(pts, fill='#e3b975' if walking else '#31495d', width=pixels, joint='curve')
            if kind == 'pedestrian':
                gpen.line(pts, fill=(255, 186, 63, 125), width=pixels + 14, joint='curve')
            if not walking and pixels > 12:
                for (x, y), (a, b) in segment_points(pts, 20 * projection.scale):
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    norm = math.hypot(dx, dy)
                    pen.line([(x, y), (x + dx / norm * 6, y + dy / norm * 6)], fill='#859190', width=2)
            if kind in ('primary', 'secondary', 'tertiary', 'pedestrian'):
                for (x, y), (a, b) in segment_points(pts, 19 * projection.scale):
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    norm = math.hypot(dx, dy)
                    for side in (-1, 1):
                        tx, ty = x - side * dy / norm * (pixels / 2 + 7), y + side * dx / norm * (pixels / 2 + 7)
                        if 0 <= tx < width and 0 <= ty < height and clip.getpixel((int(tx), int(ty))):
                            trees.append((tx, ty, rng.uniform(6.5, 10) * projection.scale))
            if kind == 'pedestrian':
                for (x, y), _ in segment_points(pts, 8 * projection.scale):
                    people.append((x + rng.uniform(-pixels / 3, pixels / 3), y + rng.uniform(-pixels / 4, pixels / 4)))
    layer = Image.alpha_composite(layer.convert('RGBA'), road_glow.filter(ImageFilter.GaussianBlur(12))).convert('RGB')
    # Geometry is clipped in map space before buildings are extruded.
    image.paste(layer, (0, 0), clip)
    pen = ImageDraw.Draw(image)
    for x, y in people:
        if 0 <= x < width and 0 <= y < height and clip.getpixel((int(x), int(y))):
            pen.ellipse((x - 2, y - 4, x + 2, y + 1), fill=rng.choice(['#d95374', '#f8e4b1', '#69adbf', '#506aaf']))
            pen.ellipse((x - 1.5, y - 6, x + 1.5, y - 3), fill='#f3c7a2')
    entries, sources = [], {}
    for f in buildings:
        for rings in polygons(f['geometry']):
            if not rings or len(rings[0]) < 4 or not all(projection.contains(p) for p in rings[0]):
                continue
            entries.append((max(projection.point(p)[1] for p in rings[0]), rings, f['properties']))
    for x, y, size in trees:
        entries.append((y, (x, y, size), None))
    light = Image.new('RGBA', image.size)
    landmarks = []
    for _, rings, props in sorted(entries, key=lambda item: item[0]):
        if props is None:
            draw_tree(ImageDraw.Draw(image), *rings, rng)
            continue
        _, source = height_for(props)
        sources[source] = sources.get(source, 0) + 1
        h = draw_building(image, light, rings, props, projection)
        name = props.get('name', '')
        if name and ('IFS' in name and 'Tower' not in name or '王府井' in name):
            ring = rings[0][:-1]
            coord = [sum(p[i] for p in ring) / len(ring) for i in (0, 1)]
            x, y = projection.point(coord, h)
            landmarks.append({'name': name, 'coordinate': coord, 'pixel': projection.point(coord)})
            pen = ImageDraw.Draw(image)
            font = load_font(round(15 * projection.scale), True)
            pen.text((x, y), 'IFS' if 'IFS' in name else '王府井', font=font, fill='#ffe7ab', anchor='mm', stroke_width=1, stroke_fill='#233349')
            if 'IFS' in name:
                draw_panda(pen, x + 8 * projection.scale, y - 16 * projection.scale, projection.scale * .95)
    image = Image.alpha_composite(image.convert('RGBA'), light.filter(ImageFilter.GaussianBlur(5))).convert('RGB')
    hotspots, seen = [], set()
    for f in features:
        props = f['properties']
        if props.get('kind') != 'poi' or f['geometry']['type'] != 'Point':
            continue
        coord, name = f['geometry']['coordinates'], props.get('name', '')
        if not name or name in seen or not projection.contains(coord):
            continue
        seen.add(name)
        x, y = projection.point(coord)
        hotspots.append({'id': str(props.get('uid') or props.get('osm_id') or name), 'name': name,
                         'source': props.get('source'), 'coordinate': coord, 'coordinateSystem': 'WGS84',
                         'pixel': [round(x, 2), round(y, 2)], 'normalized': [round(x / width, 6), round(y / height, 6)]})
    # OSM-named buildings enrich the board with verified locations absent from POI search.
    for landmark in landmarks:
        if any(p['name'] == landmark['name'] for p in hotspots):
            continue
        x, y = landmark['pixel']
        hotspots.append({'id': 'building-' + landmark['name'], 'name': landmark['name'], 'source': 'OpenStreetMap',
                         'coordinate': landmark['coordinate'], 'coordinateSystem': 'WGS84',
                         'pixel': [round(x, 2), round(y, 2)], 'normalized': [round(x / width, 6), round(y / height, 6)]})
    output.mkdir(parents=True, exist_ok=True)
    image.save(output / 'chunxi-game.png', optimize=True)
    image.save(output / 'chunxi-game.webp', quality=94, method=6)
    report = {'image': 'chunxi-game.webp', 'width': width, 'height': height, 'bbox': bbox,
              'coordinateSystem': 'WGS84', 'buildings': sum(sources.values()), 'roads': len(roads),
              'hotspots': len(hotspots), 'buildingHeightSources': sources, 'style': 'illustrated-night-board',
              'camera': {'projection': 'orthographic', 'azimuthDegrees': 25, 'groundVerticalScale': projection.tilt,
                         'origin': projection.origin, 'pixelsPerMeter': projection.scale},
              'notes': ['Cached real geography. Decorative trees, pedestrians, windows and panda are artwork.',
                        'Display height above 28m compressed to 29%; not a measured 3D reconstruction.',
                        'Buildings crossing scene boundary are omitted, not extended beyond this chapter.']}
    (output / 'render.manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'chunxi-game.hotspots.json').write_text(json.dumps({'image': report['image'], 'width': width, 'height': height,
        'coordinateSystem': 'WGS84', 'hotspots': hotspots}, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'route.preview.json').write_text(json.dumps(walking_preview(features, projection), ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument('--scene', type=Path, default=root / 'output/scene.geojson')
    parser.add_argument('--output', type=Path, default=root / 'output/game')
    args = parser.parse_args()
    report = render_board(json.loads(args.scene.read_text(encoding='utf-8')), args.output)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
