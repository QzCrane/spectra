// goal: supplements missing Manifest V3 type definitions for Chrome Extension APIs

declare namespace chrome {
  namespace offscreen {
    type Reason =
      | 'AUDIO_PLAYBACK'
      | 'BLOBS'
      | 'CLIPBOARD'
      | 'DISPLAY_MEDIA'
      | 'DOM_PARSER'
      | 'DOM_SCRAPING'
      | 'GEOLOCATION'
      | 'IFRAME_SCRIPTING'
      | 'LOCAL_STORAGE'
      | 'TESTING'
      | 'USER_MEDIA'
      | 'WEB_RTC'
      | 'WORKERS';

    interface CreateParameters {
      url: string;
      reasons: Reason[];
      justification: string;
    }

    function hasDocument(): Promise<boolean>;
    function createDocument(parameters: CreateParameters): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace runtime {
    const lastError: { message?: string } | undefined;
  }

  namespace tabCapture {
    interface GetMediaStreamOptions {
      targetTabId?: number;
      consumerTabId?: number;
    }

    function getMediaStreamId(
      options: GetMediaStreamOptions,
      callback: (streamId: string) => void
    ): void;
  }

  namespace action {
    interface BadgeTextColorDetails {
      tabId?: number;
      color: string | [number, number, number, number];
    }

    function setBadgeTextColor(details: BadgeTextColorDetails): Promise<void>;
  }
}
