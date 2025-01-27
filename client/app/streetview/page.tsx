"use client";
import { Button } from "@/components/ui/button";
import { API_URL, MAPBOX_TOKEN, RAW_API_URL } from "@/lib/constants";
import {
  Bounds,
  Coords,
  Point,
  applyResultsUpdate,
  getGridSample,
  getbbox,
} from "@/lib/geo";
import {
  DrawRectangleMode,
  EditableGeoJsonLayer,
  FeatureCollection,
  ViewMode,
} from "@deck.gl-community/editable-layers";
import {
  Color,
  DeckGL,
  DeckGLRef,
  MapViewState,
  PickingInfo,
  ScatterplotLayer,
} from "deck.gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, MapRef } from "react-map-gl";
import { INITIAL_VIEW_STATE } from "@/lib/constants";
import LatLngDisplay from "@/components/widgets/InfoBar";
import ImageUpload from "@/components/widgets/imageUpload";
import OperationContainer from "@/components/widgets/ops";
import ky from "ky";
import dynamic from "next/dynamic";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
const ESearchBox = dynamic(() => import("@/components/widgets/searchBox"), {
  ssr: false,
});
import "mapbox-gl/dist/mapbox-gl.css";
import { Msg, ingestStream } from "@/lib/rpc";
import { useRouter } from "next/navigation";
import { useSift } from "@/app/sift/siftStore";
import { columnHelper } from "../sift/table";
import { TableItemsFromCoord, formatValue, getStats, zVal } from "@/lib/utils";
import { NumberPill } from "@/components/pill";
import ReactDOMServer from "react-dom/server";
import { useAPIClient, useKy } from "@/lib/api-client/api";
import { useSWRConfig } from "swr";
import { toast } from "sonner";
import {
  AlertCircle,
  CircleAlertIcon,
  MessageCircleWarningIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import EmbedMap from "@/components/embed-map";

const SAMPLE_UPPER_LIMIT = 1000;
const selectedFeatureIndexes: number[] = [];

export default function StreetView() {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [sampling, setSampling] = useState(false);
  const [locating, setLocating] = useState(false);
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const getApiClient = useAPIClient();
  const [distKm, setDistKm] = useState(0.05);
  const deckRef = useRef<DeckGLRef>(null);
  const [featCollection, setFeatCollection] = useState<FeatureCollection>({
    type: "FeatureCollection",
    features: [],
  });
  const [cursorCoords, setCursorCoords] = useState<Point>({
    lat: 0,
    lon: 0,
    aux: null,
  });
  const [sampled, setSampled] = useState<Coords | null>(null);
  const [located, setLocated] = useState<Coords | null>(null);
  const { setCols, addItems, setTargetImage } = useSift();
  const [topN, setTopN] = useState(20);
  const router = useRouter();
  const mapRef = useRef<MapRef>(null);

  const viewMode = useMemo(() => {
    let vm = selecting ? DrawRectangleMode : ViewMode;
    vm.prototype.handlePointerMove = ({ mapCoords }) => {
      setCursorCoords({
        lon: mapCoords[0],
        lat: mapCoords[1],
        aux: null,
      });
    };
    return vm;
  }, [selecting]);

  const viewedLocated = useMemo(() => {
    return located
      ? locating
        ? located.coords
        : located.coords.slice(0, topN)
      : null;
  }, [located, topN, locating]);

  const getBounds = useCallback(() => {
    if (featCollection.features.length === 0) return null;
    const coordinates = (
      featCollection.features[0].geometry.coordinates[0] as any as [
        number,
        number
      ][]
    ).map((coord: [number, number]) => ({ lon: coord[0], lat: coord[1] }));
    const bbox = getbbox(coordinates);
    const bounds: Bounds = {
      lo: { ...bbox.lo, aux: {} },
      hi: { ...bbox.hi, aux: {} },
    };
    return bounds;
  }, [featCollection]);

  const { samplePreview, sampleIsOverflowed } = useMemo(() => {
    const bounds = getBounds();
    if (!bounds || featCollection.features.length === 0 || distKm == 0)
      return { samplePreview: null, sampleIsOverflowed: false };
    try {
      let res = getGridSample(bounds, distKm);
      return {
        samplePreview: res,
        sampleIsOverflowed: res.length > SAMPLE_UPPER_LIMIT,
      };
    } catch (e) {
      return { samplePreview: null, sampleIsOverflowed: true };
    }
  }, [featCollection, distKm]);

  const layer = new EditableGeoJsonLayer({
    id: "geojson-layer",
    data: featCollection,
    mode: viewMode,
    selectedFeatureIndexes,
    onEdit: ({ updatedData }) => {
      setFeatCollection({
        type: "FeatureCollection",
        features: updatedData.features.slice(-1),
      });
    },
  });

  const samplePreviewLayer = new ScatterplotLayer({
    id: "sample-preview-layer",
    data: samplePreview,
    getPosition: (d) => [d.lon, d.lat],
    getRadius: (d) => 1,
    getFillColor: (d) => (sampleIsOverflowed ? [255, 0, 0] : [171, 157, 120]),
    radiusScale: 1,
    radiusMinPixels: 2,
    radiusMaxPixels: 100,
  });

  const sampledLayer = new ScatterplotLayer({
    id: "results-layer",
    data: sampled?.coords,
    getPosition: (d) => [d.lon, d.lat],
    getRadius: (d) => 1,
    getFillColor: (d) => [255, 140, 0],
    onClick: (info, event) => {
      navigator.clipboard.writeText(`${info.object.lat}, ${info.object.lon}`);
    },
    pickable: true,
    radiusScale: 1,
    radiusMinPixels: 2,
    radiusMaxPixels: 100,
    visible: !!sampled && !located,
  });

  const locateResultsLayer = new ScatterplotLayer<Point>({
    id: "locate-results-layer",
    data: viewedLocated,
    getPosition: (d) => [d.lon, d.lat],
    getRadius: (d) => 1,
    getFillColor: (d) =>
      [
        Math.floor(255 * Math.sqrt(d.aux.streetview_res?.max_sim)),
        140,
        0,
      ] as Color,
    onClick: (info, event) => {
      navigator.clipboard.writeText(`${info.object.lat}, ${info.object.lon}`);
    },
    pickable: true,
    radiusMinPixels: 2,
    radiusMaxPixels: 100,
  });

  const getTooltip = useCallback(({ object }: PickingInfo<Point>) => {
    if (!object?.lat) return null;
    const html = ReactDOMServer.renderToStaticMarkup(
      <div className="p-2 bg-white rounded shadow-md">
        <div className="text-sm font-medium text-gray-700">
          Coordinates: {object.lat.toFixed(4)}, {object.lon.toFixed(4)}
        </div>
        <div className="text-xs text-gray-500">
          Click to copy full coordinates
        </div>
        {object.aux.streetview_res && (
          <div className="text-sm font-medium text-gray-700">
            Similarity: {object.aux.streetview_res.max_sim}
          </div>
        )}
        {object.aux.pano_id && (
          <EmbedMap
            panoId={object.aux.pano_id}
            coord={{
              lat: object.lat,
              lon: object.lon,
            }}
            viewType="streetview"
            autofocus
          />
        )}
      </div>
    );

    return object
      ? {
          html: html,
        }
      : null;
  }, []);

  const onSample = async () => {
    setSampling(true);
    setSelected(true);
    setSelecting(false);
    console.log(featCollection);
    const bounds = getBounds();
    if (!bounds) {
      toast.error("No sample boundary found");
      return;
    }
    const apiClient = await getApiClient();
    let { data, error } = await apiClient.POST("/streetview/sample", {
      body: {
        bounds: bounds,
        dist_km: distKm,
      },
    });
    if (error) {
      toast.error(error.detail);
      return;
    }
    setSampled(data as Coords);
    setSampling(false);
  };

  const { mutate } = useSWRConfig();

  const onLocate = async () => {
    if (!image) {
      throw new Error("No image provided");
    }
    const payload = {
      image_url: image,
      coords: { coords: sampled!.coords },
    };

    const apiClient = await getApiClient();
    const { response, error } = await apiClient.POST(
      "/streetview/locate/streaming",
      {
        body: payload,
      }
    );

    if (error) {
      toast.error(error.detail);
      return;
    }

    if (!response.ok) {
      toast.error(`Failed to start locate: STATUS ${response.statusText}`);
      return;
    }

    mutate("/api/usage");

    for await (const msg of ingestStream(response)) {
      console.log("got message! ", msg);
      switch (msg.type) {
        case "ResultsUpdate":
          setLocated((loc) => {
            if (loc?.coords?.length) {
              console.log("Old coords:", loc.coords);
              let new_coords = applyResultsUpdate(loc!, msg, "streetview_res");
              console.log("New coords (extension):", new_coords);
              return new_coords;
            }
            return applyResultsUpdate(sampled!, msg, "streetview_res");
          });
          break;
        case "ProgressUpdate":
          console.log(msg);
          break;
        default:
          break;
      }
    }

    setLocated((loc) => {
      return {
        coords: loc!.coords.sort(
          (a, b) => b.aux.streetview_res.max_sim - a.aux.streetview_res.max_sim
        ),
      };
    });
  };

  const locateWrapper = async () => {
    setLocating(true);
    try {
      await onLocate();
    } catch (e) {
      console.log(e);
    } finally {
      setLocating(false);
    }
  };

  const activeLayers = useMemo(() => {
    if (located) {
      return [layer, locateResultsLayer];
    } else if (sampled?.coords.length && sampled.coords.length > 0) {
      return [layer, sampledLayer];
    } else {
      return [layer, samplePreviewLayer];
    }
  }, [
    located,
    sampled,
    layer,
    locateResultsLayer,
    sampledLayer,
    samplePreviewLayer,
  ]);

  return (
    <div className="relative h-screen w-full overflow-hidden">
      <div
        className={`absolute w-full h-full ${
          selecting ? "cursor-crosshair" : ""
        }`}
      >
        <DeckGL
          initialViewState={viewState}
          controller
          layers={activeLayers}
          getTooltip={getTooltip}
          ref={deckRef}
          getCursor={(st) => {
            if (selecting) return "crosshair";
            if (st.isDragging) return "grabbing";
            return "grab";
          }}
        >
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            mapStyle="mapbox://styles/mapbox/satellite-streets-v12"
            ref={mapRef}
          ></Map>
        </DeckGL>
      </div>
      <OperationContainer className="bg-opacity-85">
        <article className="prose prose-sm leading-5 mb-3">
          <h3>Streetview Geolocalization</h3>
          Select an area, and this will iterate through streetview images within
          that area to find the best match for your image.
        </article>
        <div className="flex flex-col gap-2">
          <ImageUpload
            onSetImage={setImage}
            image={image}
            className="border-stone-400"
          />
          <Label htmlFor="dist-slider">Sample Gap: {distKm * 1000} m</Label>
          <Slider
            id="dist-slider"
            value={[distKm]}
            onValueChange={(v) => setDistKm(v[0])}
            min={0.01}
            max={0.1}
            step={0.001}
          />
          {selecting || selected ? (
            <div className="flex flex-row gap-2">
              <Button
                disabled={
                  featCollection.features.length === 0 ||
                  sampling ||
                  sampleIsOverflowed === true
                }
                onClick={() => {
                  console.log(featCollection);
                  onSample();
                }}
              >
                {sampling ? "Fetching..." : "Fetch Streetviews"}
              </Button>
              <Button
                onClick={() => {
                  setSelecting(false);
                  setFeatCollection({
                    type: "FeatureCollection",
                    features: [],
                  });
                }}
                variant="secondary"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => setSelecting(true)}>
              Select Search Range
            </Button>
          )}
          {sampleIsOverflowed && (
            <Alert variant="destructive" className="bg-white bg-opacity-75">
              <AlertCircle className="size-4" />
              <AlertTitle>Too many samples!</AlertTitle>
              <AlertDescription>
                Please increase the sample gap or decrease the search area.
              </AlertDescription>
            </Alert>
          )}
          <Button
            onClick={locateWrapper}
            disabled={!sampled || locating || !image}
            requireLogin
          >
            {locating ? "Locating..." : "Run Similarity Search"}
          </Button>
          <Label htmlFor="topn-slider">Top {topN} Results</Label>
          <Slider
            id="topn-slider"
            value={[topN]}
            onValueChange={(v) => setTopN(v[0])}
            min={1}
            max={sampled?.coords.length || 50}
            step={1}
          />
          <Button
            onClick={() => {
              if (located) {
                const stats = getStats(
                  located!.coords.map((c) => c.aux.streetview_res.max_sim)
                );
                setCols((cols) => [
                  ...cols,
                  {
                    type: "NumericalCol",
                    accessor: "streetview_res.max_sim",
                    header: "Streetview Similarity",
                    ...stats,
                  },
                ]);
                addItems(TableItemsFromCoord(located!));
              } else if (sampled) {
                addItems(TableItemsFromCoord(sampled!));
              }
              if (image) {
                setTargetImage(image);
              }
              router.push("/sift");
            }}
            disabled={!located && !sampled}
          >
            Sift{" "}
            {located
              ? located.coords.length
              : sampled
              ? sampled.coords.length
              : ""}{" "}
            Streetviews
          </Button>
        </div>
      </OperationContainer>
      <ESearchBox setViewState={setViewState} dglref={deckRef} />
      <LatLngDisplay cursorCoords={cursorCoords} />
    </div>
  );
}
