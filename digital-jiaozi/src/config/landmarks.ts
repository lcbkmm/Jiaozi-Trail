// Paths resolve against deployed assetBase. Change only this manifest for final art.
export interface Landmark {
  id: string; placeId: string | null; name: string; color: string; image: string;
  placeholder: boolean; map: { fit: 'contain' | 'cover'; position: string };
}
export const LANDMARKS: readonly Landmark[] = [
  { id: 'landmark-01', placeId: null, name: '成都 IFS', color: '#bf5d7c', image: 'assets/landmarks/landmark-01.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } },
  { id: 'landmark-02', placeId: null, name: '太古里', color: '#367968', image: 'assets/landmarks/landmark-02.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } },
  { id: 'landmark-03', placeId: null, name: '九眼桥', color: '#66549b', image: 'assets/landmarks/landmark-03.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } },
  { id: 'landmark-04', placeId: null, name: '大慈寺', color: '#aa8542', image: 'assets/landmarks/landmark-04.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } },
  { id: 'landmark-05', placeId: null, name: '水井坊', color: '#9b683f', image: 'assets/landmarks/landmark-05.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } },
  { id: 'landmark-06', placeId: null, name: '三圣乡', color: '#7a9546', image: 'assets/landmarks/landmark-06.webp', placeholder: false, map: { fit: 'contain', position: '50% 50%' } }
];
