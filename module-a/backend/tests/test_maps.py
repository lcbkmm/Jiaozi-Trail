import asyncio
import httpx
import pytest
from app.errors import AppError
from app.maps.baidu import BaiduMaps
from app.maps.segments import SegmentRepository


def test_map_coordinate_order_and_real_path_parsing(sample):
    async def run():
        places,*_=sample
        a,b=places[:2]
        def handler(request):
            assert request.url.params["origin"]==f"{a.latitude},{a.longitude}"
            assert request.url.params["coord_type"]=="gcj02"
            return httpx.Response(200,json={"status":0,"result":{"routes":[{"distance":123,"duration":100,"steps":[{"path":"104.08,30.65;104.081,30.65"}]}]}})
        async with httpx.AsyncClient(base_url="https://test.invalid",transport=httpx.MockTransport(handler)) as client:
            leg=await BaiduMaps(client,"test-credential").walking(a,b)
            assert leg.distance_m==123 and leg.duration_s==100
            assert leg.points[0].longitude==104.08 and leg.points[0].latitude==30.65
    asyncio.run(run())


def test_upstream_error_does_not_include_secret():
    async def run():
        def handler(request):return httpx.Response(200,json={"status":210,"message":"secret-test-key"})
        async with httpx.AsyncClient(base_url="https://test.invalid",transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(AppError) as caught:await BaiduMaps(client,"secret-test-key").search("test")
            assert "secret-test-key" not in str(caught.value)
            assert caught.value.details=={"provider_status":210}
    asyncio.run(run())


def test_segment_keys_preserve_direction_and_entrance_changes(sample):
    places,*_=sample
    a,b=places[:2]
    assert SegmentRepository.cache_key(a,b)!=SegmentRepository.cache_key(b,a)
    assert SegmentRepository.cache_key(a,b)!=SegmentRepository.cache_key(a,b.model_copy(update={"entrance_version":2}))
