from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient):
    response = await client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "healthy"}


@pytest.mark.asyncio
async def test_health_check_reports_redis_down(client: AsyncClient, _mock_redis):
    _mock_redis.ping = AsyncMock(side_effect=ConnectionError("redis down"))

    response = await client.get("/api/health")

    assert response.status_code == 503
    assert response.json() == {
        "status": "unhealthy",
        "checks": {"database": "ok", "redis": "error"},
    }
