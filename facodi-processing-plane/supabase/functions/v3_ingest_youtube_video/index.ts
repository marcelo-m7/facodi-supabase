import { handleVideoIngest } from "../_shared/v3_video_ingest.ts";

Deno.serve((req) =>
  handleVideoIngest(req, {
    mechanism: "v3_ingest_youtube_video",
  })
);
