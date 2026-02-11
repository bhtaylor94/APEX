"""
National Weather Service (NWS) Data Feed.

Fetches weather forecasts and observations from the NWS API.
This is the authoritative data source for Kalshi weather market settlement.

NWS API docs: https://www.weather.gov/documentation/services-web-api
"""

import logging
from typing import Optional
from dataclasses import dataclass

import requests

logger = logging.getLogger(__name__)

NWS_API_BASE = "https://api.weather.gov"
NWS_USER_AGENT = "KalshiTradingBot/1.0 (contact@example.com)"


@dataclass
class WeatherForecast:
    """Structured weather forecast for a location."""

    station: str
    city: str
    forecast_high: Optional[float] = None  # Fahrenheit
    forecast_low: Optional[float] = None
    current_temp: Optional[float] = None
    hourly_temps: list[float] = None  # List of hourly forecast temps
    conditions: str = ""
    wind_speed: str = ""
    timestamp: str = ""

    def __post_init__(self):
        if self.hourly_temps is None:
            self.hourly_temps = []


class NWSDataFeed:
    """
    Fetches forecast and observation data from the National Weather Service.

    Weather markets on Kalshi settle based on the NWS Daily Climate Report.
    Stations:
      - NYC: Central Park (KNYC)
      - Chicago: Midway Airport (KMDW)
      - Miami: Miami International (KMIA)
      - Austin: Austin-Bergstrom (KAUS)
    """

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": NWS_USER_AGENT})

    def get_point_forecast(self, lat: float, lon: float) -> dict:
        """
        Get the forecast for a geographic point.
        First gets the grid coordinates, then fetches the forecast.
        """
        try:
            # Step 1: Get grid endpoint for this location
            point_url = f"{NWS_API_BASE}/points/{lat},{lon}"
            resp = self.session.get(point_url, timeout=15)
            resp.raise_for_status()
            point_data = resp.json()

            forecast_url = point_data["properties"]["forecast"]
            hourly_url = point_data["properties"]["forecastHourly"]

            # Step 2: Get the forecast
            forecast_resp = self.session.get(forecast_url, timeout=15)
            forecast_resp.raise_for_status()
            forecast_data = forecast_resp.json()

            # Step 3: Get hourly forecast
            hourly_resp = self.session.get(hourly_url, timeout=15)
            hourly_resp.raise_for_status()
            hourly_data = hourly_resp.json()

            return {
                "forecast": forecast_data,
                "hourly": hourly_data,
            }

        except requests.RequestException as e:
            logger.error(f"NWS API error for ({lat}, {lon}): {e}")
            return {}

    def get_current_observations(self, station: str) -> dict:
        """
        Get the latest observation from a weather station.

        Args:
            station: Station ID (e.g., 'KNYC', 'KMDW')
        """
        try:
            url = f"{NWS_API_BASE}/stations/{station}/observations/latest"
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            logger.error(f"NWS observation error for {station}: {e}")
            return {}

    def get_weather_forecast(self, station: str, lat: float, lon: float, city: str) -> WeatherForecast:
        """
        Build a complete WeatherForecast for a Kalshi weather market.

        Combines point forecast and current observations.
        """
        forecast = WeatherForecast(station=station, city=city)

        # Get current observations
        obs_data = self.get_current_observations(station)
        if obs_data:
            props = obs_data.get("properties", {})
            temp_c = props.get("temperature", {}).get("value")
            if temp_c is not None:
                forecast.current_temp = round(temp_c * 9 / 5 + 32, 1)  # C to F
            forecast.conditions = props.get("textDescription", "")
            wind = props.get("windSpeed", {}).get("value")
            if wind is not None:
                forecast.wind_speed = f"{round(wind * 0.621371, 1)} mph"

        # Get point forecast
        point_data = self.get_point_forecast(lat, lon)
        if point_data:
            # Extract daily forecast
            periods = point_data.get("forecast", {}).get("properties", {}).get("periods", [])
            for period in periods[:2]:  # Today and Tonight
                if period.get("isDaytime", False):
                    forecast.forecast_high = float(period.get("temperature", 0))
                else:
                    forecast.forecast_low = float(period.get("temperature", 0))

            # Extract hourly temps
            hourly_periods = (
                point_data.get("hourly", {}).get("properties", {}).get("periods", [])
            )
            forecast.hourly_temps = [
                float(p.get("temperature", 0)) for p in hourly_periods[:24]
            ]

        return forecast

    def estimate_high_temperature(self, station: str, lat: float, lon: float, city: str) -> Optional[float]:
        """
        Get our best estimate of today's high temperature for a station.

        This combines:
        1. NWS point forecast high
        2. Current observation (if already higher than forecast, adjust up)
        3. Hourly forecast trajectory
        """
        forecast = self.get_weather_forecast(station, lat, lon, city)

        estimates = []

        # NWS forecast high
        if forecast.forecast_high is not None:
            estimates.append(forecast.forecast_high)

        # If current temp exceeds forecast, that's our floor
        if forecast.current_temp is not None:
            estimates.append(forecast.current_temp)

        # Hourly forecast max
        if forecast.hourly_temps:
            estimates.append(max(forecast.hourly_temps))

        if not estimates:
            return None

        # Take the maximum as our best estimate
        # (if current temp already exceeds forecast, the high will be at least that)
        return max(estimates)
