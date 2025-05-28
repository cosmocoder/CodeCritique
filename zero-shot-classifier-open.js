/**
 * Open-ended Zero-Shot Classification Module
 *
 * This module provides zero-shot classification without predefined categories,
 * allowing it to detect any technology or framework mentioned in the text.
 */

import { env, pipeline } from '@huggingface/transformers';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';
import fs from 'fs';
import path from 'path';

// Configure Transformers.js environment
env.allowLocalModels = false;
env.useBrowserCache = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * OpenZeroShotClassifier for unrestricted technology detection
 */
export class OpenZeroShotClassifier {
  constructor() {
    this.classifier = null;
    this.initializationPromise = null;
    this.cache = new LRUCache({
      max: 100,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });
    this.isInitialized = false;

    // Common words to exclude from technology detection
    this.commonWords = new Set([
      'the',
      'this',
      'that',
      'with',
      'from',
      'into',
      'using',
      'building',
      'creating',
      'making',
      'developing',
      'writing',
      'implementing',
      'designing',
      'working',
      'getting',
      'setting',
      'running',
      'testing',
      'debugging',
      'deploying',
      'installing',
      'configuring',
      'managing',
      'maintaining',
      'updating',
      'for',
      'and',
      'but',
      'or',
      'nor',
      'yet',
      'so',
      'because',
      'since',
      'although',
      'though',
      'while',
      'when',
      'where',
      'how',
      'why',
      'what',
      'which',
      'who',
      'whom',
      'whose',
      'can',
      'could',
      'will',
      'would',
      'should',
      'must',
      'may',
      'might',
      'shall',
      'need',
      'want',
      'like',
      'use',
      'uses',
      'used',
      'make',
      'makes',
      'made',
      'get',
      'gets',
      'got',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'be',
      'is',
      'are',
      'was',
      'were',
      'been',
      'being',
      'very',
      'really',
      'quite',
      'just',
      'only',
      'also',
      'too',
      'either',
      'neither',
      'both',
      'all',
      'some',
      'any',
      'many',
      'much',
      'few',
      'little',
      'more',
      'most',
      'less',
      'least',
      'good',
      'better',
      'best',
      'bad',
      'worse',
      'worst',
      'new',
      'old',
      'first',
      'last',
      'next',
      'previous',
      'current',
      'future',
      'past',
      'high',
      'low',
      'big',
      'small',
      'large',
      'tiny',
      'huge',
      'fast',
      'slow',
      'quick',
      'easy',
      'hard',
      'simple',
      'complex',
      'basic',
      'advanced',
      'beginner',
      'intermediate',
      'expert',
      'professional',
      'were',
      'our',
      'legacy',
      'system',
      'modern',
      'architecture',
      'stack',
      'high-performance',
      'real-time',
      'features',
      'reactive',
      'frontend',
      'data',
      'processing',
      'stream',
      'analytics',
      'infrastructure',
      'runs',
      'orchestration',
      'instead',
      'service',
      'mesh',
      'experimenting',
      'tools',
      'fast',
      'runtime',
      'desktop',
      'apps',
      'workloads',
      'entire',
      'pipeline',
      'reproducible',
      'builds',
      'migrating',
      'team',
      'interfaces',
      'queries',
      'temporal',
      'distributed',
      'computing',
      'database',
      'graph',
    ]);

    // Common technology patterns for extraction
    this.techPatterns = [
      /\b(\w+\.js)\b/gi, // Matches *.js frameworks
      /\b(\w+\.py)\b/gi, // Matches *.py libraries
      /\b([A-Z][a-zA-Z]+(?:[A-Z][a-zA-Z]+)*)\b/g, // CamelCase (React, FastAPI)
      /\b([a-z]+(?:-[a-z]+)+)\b/gi, // kebab-case (scikit-learn, styled-components)
      /\b(pandas|numpy|tensorflow|pytorch|keras|django|flask|fastapi|express|nestjs|react|angular|vue|svelte|next\.js|nuxt\.js|gatsby|webpack|babel|typescript|javascript|python|java|ruby|php|go|rust|kotlin|swift|dart|elixir|scala|clojure|haskell|erlang|julia|r|matlab|fortran|cobol|pascal|ada|lisp|scheme|prolog|sql|nosql|mongodb|postgresql|mysql|redis|elasticsearch|kafka|rabbitmq|docker|kubernetes|terraform|ansible|jenkins|gitlab|github|aws|azure|gcp|heroku|netlify|vercel)\b/gi,
    ];
  }

  /**
   * Initialize the zero-shot classification pipeline
   */
  async initialize() {
    if (this.isInitialized) return;

    if (!this.initializationPromise) {
      this.initializationPromise = this._doInitialize();
    }

    await this.initializationPromise;
  }

  async _doInitialize() {
    try {
      console.log('Initializing open-ended zero-shot classifier...');

      this.classifier = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli', {
        quantized: true,
      });

      this.isInitialized = true;
      console.log('Open-ended zero-shot classifier initialized successfully');
    } catch (error) {
      console.error('Error initializing classifier:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Extract potential technology candidates from text
   */
  extractTechnologyCandidates(text) {
    const candidates = new Set();

    // First, look for known technology patterns in the text
    const knownTechRegex =
      /\b(react|angular|vue|svelte|solid|qwik|alpine|ember|backbone|jquery|next\.?js|nuxt\.?js|gatsby|remix|astro|vite|webpack|rollup|parcel|babel|typescript|javascript|coffeescript|purescript|elm|reasonml|python|django|flask|fastapi|pyramid|tornado|bottle|java|spring|struts|hibernate|kotlin|scala|groovy|clojure|ruby|rails|sinatra|hanami|php|laravel|symfony|codeigniter|yii|csharp|c#|\.net|dotnet|aspnet|blazor|go|golang|gin|echo|fiber|beego|rust|actix|rocket|warp|tokio|swift|vapor|perfect|kitura|dart|flutter|elixir|phoenix|erlang|haskell|yesod|scotty|snap|ocaml|fsharp|f#|julia|nim|zig|crystal|d|dlang|perl|raku|lua|love2d|r|shiny|matlab|fortran|cobol|pascal|ada|lisp|clojure|scheme|racket|prolog|sql|nosql|postgresql|postgres|mysql|mariadb|sqlite|oracle|sqlserver|mongodb|couchdb|cassandra|redis|memcached|elasticsearch|solr|neo4j|graphql|rest|grpc|soap|rabbitmq|kafka|nats|zeromq|docker|kubernetes|k8s|openshift|swarm|podman|terraform|ansible|puppet|chef|saltstack|vagrant|packer|jenkins|gitlab|github|bitbucket|circleci|travisci|aws|azure|gcp|google cloud|heroku|netlify|vercel|railway|render|fly\.io|digitalocean|linode|vultr|nginx|apache|caddy|traefik|haproxy|tomcat|jetty|iis|express|koa|hapi|fastify|nestjs|adonisjs|sails|meteor|deno|bun|node\.?js|npm|yarn|pnpm|pip|poetry|cargo|maven|gradle|sbt|leiningen|mix|hex|composer|bundler|gem|nuget|cocoapods|homebrew|apt|yum|pacman|htmx|alpinejs|stimulus|turbo|hotwire|tailwind|bootstrap|bulma|material-ui|mui|ant design|chakra|semantic ui|foundation|uikit|primevue|vuetify|quasar|element|naive ui|arco|semi|mantine|nextui|daisyui|headlessui|radix|shadcn|pandas|numpy|scipy|matplotlib|seaborn|plotly|scikit-learn|sklearn|tensorflow|pytorch|keras|jax|mxnet|caffe|theano|opencv|nltk|spacy|gensim|transformers|huggingface|langchain|llamaindex|openai|anthropic|cohere|pinecone|weaviate|chroma|qdrant|milvus|faiss|annoy|scann|vertex|sagemaker|mlflow|kubeflow|airflow|prefect|dagster|dbt|spark|hadoop|hive|presto|trino|flink|storm|samza|beam|dataflow|bigquery|redshift|snowflake|databricks|tableau|powerbi|looker|metabase|superset|grafana|prometheus|datadog|newrelic|sentry|rollbar|bugsnag|logstash|fluentd|graylog|splunk|sumologic|auth0|okta|keycloak|firebase|supabase|appwrite|hasura|prisma|typeorm|sequelize|mongoose|mikro-orm|drizzle|knex|objection|waterline|bookshelf|massive|pg-promise|mysql2|mariadb|oracledb|tedious|mssql|sqlite3|better-sqlite3|mongodb|mongoose|redis|ioredis|bull|bullmq|celery|sidekiq|resque|delayed_job|hangfire|quartz|activemq|artemis|pulsar|eventbridge|kinesis|sqs|sns|pubsub|cloud tasks|cloud functions|lambda|vercel functions|netlify functions|cloudflare workers|durable objects|r2|s3|gcs|blob storage|spaces|minio|ceph|glusterfs|nfs|zfs|btrfs|ext4|xfs|apfs|ntfs|fat32|exfat|git|svn|mercurial|perforce|tfs|vscode|vim|neovim|emacs|sublime|atom|brackets|notepad\+\+|intellij|eclipse|netbeans|xcode|android studio|visual studio|rider|webstorm|phpstorm|pycharm|rubymine|goland|clion|datagrip|postman|insomnia|paw|httpie|curl|wget|axios|fetch|request|superagent|got|ky|swr|react-query|tanstack|apollo|relay|urql|graphql-request|prisma|nexus|typegraphql|graphql-yoga|graphql-tools|graphql-codegen|swagger|openapi|raml|asyncapi|json-schema|protobuf|avro|thrift|messagepack|cbor|bson|xml|yaml|toml|ini|env|json|csv|parquet|orc|arrow|hdf5|netcdf|geojson|shapefile|kml|gpx|osm|pbf|mbtiles|pmtiles|vector tiles|raster tiles|wms|wfs|wcs|wmts|tms|xyz|bing|google|mapbox|esri|here|tomtom|openstreetmap|leaflet|openlayers|maplibre|cesium|deck\.gl|kepler\.gl|uber|lyft|grab|ola|didi|bolt|freenow|cabify|beat|kapten|mytaxi|gett|juno|via|curb|flywheel|hailo|addison lee|blacklane|chauffeur|limousine|taxi|rideshare|carpool|vanpool|microtransit|paratransit|demand responsive|mobility|maas|transportation|transit|public transport|bus|tram|metro|subway|train|rail|light rail|commuter rail|high speed rail|maglev|hyperloop|monorail|cable car|gondola|funicular|ferry|water taxi|hovercraft|hydrofoil|catamaran|cruise|cargo|freight|logistics|supply chain|warehouse|distribution|fulfillment|last mile|delivery|courier|postal|parcel|package|shipping|trucking|rail freight|air cargo|ocean freight|intermodal|multimodal|transshipment|cross-docking|consolidation|deconsolidation|customs|clearance|brokerage|forwarding|3pl|4pl|5pl|lsp|tms|wms|erp|crm|scm|plm|mes|qms|eam|cmms|hrms|hris|hcm|ats|lms|cms|dms|ecm|dam|pim|mdm|cdp|dmp|crm|marketing automation|email marketing|social media|seo|sem|ppc|display advertising|programmatic|retargeting|remarketing|attribution|analytics|tag management|consent management|privacy|gdpr|ccpa|lgpd|pipeda|pecr|can-spam|casl|tcpa|coppa|ferpa|hipaa|sox|pci dss|iso 27001|soc 2|nist|cis|owasp|sans|mitre|att&ck|cyber kill chain|diamond model|stix|taxii|yara|sigma|snort|suricata|zeek|bro|wireshark|tcpdump|nmap|masscan|zmap|metasploit|burp suite|zap|nikto|sqlmap|hydra|john|hashcat|aircrack|kismet|wifi pineapple|rubber ducky|bash bunny|lan turtle|packet squirrel|shark jack|key croc|screen crab|omg cable|malduino|digispark|teensy|arduino|raspberry pi|esp8266|esp32|stm32|pic|avr|arm|risc-v|fpga|asic|soc|mcu|dsp|gpu|tpu|npu|quantum|blockchain|bitcoin|ethereum|solana|cardano|polkadot|cosmos|avalanche|near|algorand|tezos|eos|tron|binance|polygon|arbitrum|optimism|zksync|starknet|lightning|raiden|plasma|rollup|sidechain|bridge|oracle|chainlink|band|api3|uma|augur|gnosis|polymarket|uniswap|sushiswap|pancakeswap|curve|balancer|aave|compound|maker|synthetix|yearn|convex|lido|rocket pool|frax|olympus|wonderland|time|spell|mim|usdc|usdt|dai|ust|frax|fei|rai|lusd|susd|gusd|usdp|busd|tusd|husd|usdn|usdk|usdx|usd\+\+|nft|defi|dao|dex|cex|amm|yield|farming|staking|liquidity|mining|vault|lending|borrowing|margin|leverage|perpetual|futures|options|derivatives|synthetic|wrapped|pegged|stable|coin|token|altcoin|memecoin|shitcoin|rugpull|honeypot|ponzi|pyramid|mlm|scam|fraud|hack|exploit|vulnerability|bug|bounty|audit|security|pentesting|redteam|blueteam|purpleteam|soc|siem|soar|xdr|edr|ndr|mdr|dlp|casb|sase|ztna|sdwan|firewall|ids|ips|waf|ddos|cdn|load balancer|reverse proxy|api gateway|service mesh|istio|linkerd|consul|envoy|kong|tyk|apigee|mulesoft|boomi|zapier|ifttt|automate|flow|logic apps|power automate|workato|integromat|make|n8n|node-red|apache nifi|streamsets|talend|informatica|datastage|ssis|pentaho|kettle|airbyte|fivetran|stitch|singer|meltano|dbt|dataform|sqlmesh|cube|metricflow|lightdash|preset|redash|blazer|popsql|querybook|hue|zeppelin|jupyter|colab|kaggle|databricks|sagemaker|vertex|azure ml|watson|h2o|datarobot|c3\.ai|palantir|snowflake|databricks|confluent|elastic|splunk|datadog|new relic|dynatrace|appdynamics|instana|honeycomb|lightstep|jaeger|zipkin|tempo|loki|cortex|thanos|victoriametrics|influxdb|timescale|questdb|clickhouse|druid|pinot|rockset|materialize|ksqldb|flink sql|spark sql|presto sql|trino sql|dremio|starburst|ahana|varada|kylin|druid|superset|preset|looker|tableau|powerbi|qlik|sisense|domo|gooddata|thoughtspot|mode|periscope|chartio|metabase|redash|blazer|holistics|steep|grow|klipfolio|geckoboard|databox|cyfe|freeboard|smashing|dashing|grafana|kibana|chronograf|lens|k9s|octant|headlamp|portainer|rancher|openshift|tanzu|anthos|eks|aks|gke|doks|lke|vke|civo|k3s|k0s|microk8s|minikube|kind|k3d|tilt|skaffold|draft|forge|gitkube|flagger|argo|flux|spinnaker|harness|codefresh|circleci|travis|jenkins|bamboo|teamcity|octopus|azure devops|aws codepipeline|gcp cloud build|gitlab ci|github actions|bitbucket pipelines|drone|concourse|gocd|buddy|semaphore|buildkite|appveyor|shippable|codeship|wercker|magnum|solano|snap|distelli|electric cloud|xebialabs|cloudbees|urban code|puppet enterprise|chef automate|ansible tower|salt enterprise|terraform cloud|terraform enterprise|spacelift|env0|scalr|morpheus|cloudify|crossplane|pulumi|cdk|cdktf|troposphere|stacker|sceptre|rain|sam|serverless|chalice|zappa|claudia|apex|gordon|sparta|aegis|dawson|colly|scrapy|beautifulsoup|selenium|puppeteer|playwright|cypress|testcafe|nightwatch|webdriverio|protractor|casperjs|phantomjs|slimerjs|zombie|cheerio|jsdom|htmlparser|xmldom|xpath|css selectors|regex|glob|minimatch|micromatch|picomatch|nanomatch|extglob|braces|expand-brackets|snapdragon|anymatch|chokidar|gaze|watch|nodemon|pm2|forever|supervisor|systemd|upstart|init\.d|rc\.d|cron|at|anacron|fcron|dcron|cronie|vixie|quartz|hangfire|celery beat|apscheduler|schedule|crontab|cronjob|scheduled task|timer|alarm|reminder|notification|alert|email|sms|push|webhook|slack|discord|telegram|whatsapp|signal|matrix|irc|xmpp|jabber|rocketchat|mattermost|zulip|gitter|hipchat|stride|flock|twist|chanty|ryver|glip|workplace|yammer|chatter|jive|confluence|sharepoint|notion|coda|airtable|clickup|monday|asana|trello|jira|linear|shortcut|clubhouse|pivotal|targetprocess|rally|versionone|azure boards|github issues|gitlab issues|bitbucket issues|youtrack|redmine|trac|bugzilla|mantis|fogbugz|manuscript|phabricator|reviewboard|gerrit|crucible|collaborator|codestream|codescene|codefactor|codacy|codeclimate|sonarqube|sonarcloud|coverity|fortify|checkmarx|veracode|snyk|whitesource|black duck|synopsis|twistlock|aqua|sysdig|falco|anchore|clair|trivy|grype|syft|cosign|sigstore|notary|tuf|in-toto|slsa|sbom|spdx|cyclonedx|swid|cpe|cve|cwe|cvss|epss|kev|vex|csaf|oval|scap|stix|taxii|misp|yara|sigma|att&ck|d3fend|veris|kill chain|diamond model|pyramid of pain|cyber threat intelligence|threat hunting|threat modeling|stride|pasta|linddun|octave|fair|nist rmf|iso 27005|cobit|itil|togaf|zachman|dodaf|modaf|naf|uaf|archimate|bpmn|uml|sysml|sparx|magicdraw|rhapsody|visual paradigm|lucidchart|draw\.io|diagrams\.net|miro|mural|figma|sketch|adobe xd|invision|marvel|principle|flinto|origami|framer|protopie|axure|balsamiq|mockplus|justinmind|uxpin|webflow|bubble|adalo|glide|softr|retool|tooljet|budibase|appsmith|dronahq|mendix|outsystems|powerapps|appian|pega|salesforce|servicenow|workday|sap|oracle|microsoft|google|amazon|apple|meta|netflix|uber|airbnb|spotify|stripe|square|paypal|shopify|atlassian|slack|zoom|twilio|sendgrid|mailchimp|hubspot|zendesk|intercom|segment|amplitude|mixpanel|heap|fullstory|hotjar|crazy egg|optimizely|vwo|google optimize|adobe target|dynamic yield|monetate|evergage|sailthru|braze|iterable|klaviyo|customer\.io|urban airship|onesignal|pusher|pubnub|ably|socket\.io|signalr|mercure|centrifugo|soketi|laravel echo|phoenix channels|action cable|anycable|hotwire|turbo|stimulus|livewire|liveview|blazor server|vaadin|gwt|wicket|tapestry|struts|jsf|primefaces|richfaces|icefaces|myfaces|mojarra|spring mvc|spring boot|spring cloud|spring data|spring security|spring batch|spring integration|spring webflux|project reactor|rxjava|akka|vert\.x|quarkus|micronaut|helidon|dropwizard|ratpack|javalin|sparkjava|play|lagom|akka http|http4s|finch|scalatra|lift|skinny|rails api|grape|roda|hanami api|sinatra|padrino|cuba|roda|syro|hobbit|nancy|servicestack|carter|giraffe|saturn|falco|suave|freya|hopac|orleans|dapr|mass transit|nservicebus|rebus|brighter|mediatr|marten|eventstore|axon|eventuate|lagom|cloudstate|cloudflow|flink stateful|kafka streams|samza|storm trident|spark structured streaming|beam stateful|temporal|cadence|camunda|zeebe|activiti|flowable|jbpm|drools|optaplanner|kogito|serverless workflow|step functions|logic apps|power automate|zapier|ifttt|integromat|make|n8n|node-red|apache airflow|prefect|dagster|luigi|argo workflows|tekton|brigade|keptn|flagger|shipper|spinnaker|harness|launchdarkly|split|optimizely|unleash|flagsmith|flipper|rollout|cloudbees|configcat|statsig|growthbook|eppo|amplitude experiment|firebase remote config|aws appconfig|azure app configuration)\b/gi;

    // Extract using known tech regex
    const knownMatches = text.matchAll(knownTechRegex);
    for (const match of knownMatches) {
      const tech = match[0];
      candidates.add(tech);
    }

    // Extract using patterns
    for (const pattern of this.techPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const candidate = match[1] || match[0];
        if (candidate.length > 2 && candidate.length < 30 && !this.commonWords.has(candidate.toLowerCase())) {
          candidates.add(candidate);
        }
      }
    }

    // Extract capitalized words that might be technologies
    const sentences = text.split(/[.!?]+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        const word = words[i].replace(/[.,;:!?'"()[\]{}]/g, '');

        // Skip if it's a common word
        if (this.commonWords.has(word.toLowerCase())) continue;

        // Check if word is capitalized and not at sentence start
        if (i > 0 && /^[A-Z][a-zA-Z]+/.test(word) && word.length > 2 && word.length < 20) {
          candidates.add(word);
        }

        // Also check for acronyms
        if (/^[A-Z]{2,6}$/.test(word)) {
          candidates.add(word);
        }
      }
    }

    return Array.from(candidates);
  }

  /**
   * Classify if the text is about each candidate technology
   */
  async classifyTechnologies(text, minConfidence = 0.3) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const cacheKey = `tech:${text.substring(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Extract technology candidates
      const candidates = this.extractTechnologyCandidates(text);

      if (candidates.length === 0) {
        return [];
      }

      // Truncate text for classification
      const truncatedText = text.substring(0, 1000); // Reduced to avoid token limit errors

      // Create hypotheses for each candidate
      const hypotheses = candidates.map((tech) => `This text is about ${tech}`);

      // Classify
      const result = await this.classifier(truncatedText, hypotheses, {
        multi_label: true,
      });

      // Process results
      const classifications = [];
      for (let i = 0; i < result.labels.length; i++) {
        if (result.scores[i] >= minConfidence) {
          // Extract technology name from hypothesis
          const tech = result.labels[i].replace('This text is about ', '');
          classifications.push({
            technology: tech,
            confidence: result.scores[i],
          });
        }
      }

      // Sort by confidence
      classifications.sort((a, b) => b.confidence - a.confidence);

      this.cache.set(cacheKey, classifications);
      return classifications;
    } catch (error) {
      console.error('Error in technology classification:', error);
      return [];
    }
  }

  /**
   * Classify the general area/domain of the documentation
   */
  async classifyDomain(text, minConfidence = 0.3) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const cacheKey = `domain:${text.substring(0, 100)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const truncatedText = text.substring(0, 1000); // Reduced to avoid token limit errors

      // Open-ended domain hypotheses
      const domainHypotheses = [
        'This is frontend/UI documentation',
        'This is backend/server documentation',
        'This is database documentation',
        'This is DevOps/infrastructure documentation',
        'This is mobile app documentation',
        'This is data science/ML documentation',
        'This is API documentation',
        'This is security documentation',
        'This is testing documentation',
        'This is architecture documentation',
        'This is getting started/setup documentation',
        'This is configuration documentation',
        'This is deployment documentation',
        'This is troubleshooting documentation',
        'This is reference documentation',
        'This is tutorial documentation',
        'This is best practices documentation',
        'This is changelog/release notes',
      ];

      const result = await this.classifier(truncatedText, domainHypotheses, {
        multi_label: true,
      });

      // Process results
      const classifications = [];
      for (let i = 0; i < result.labels.length; i++) {
        if (result.scores[i] >= minConfidence) {
          classifications.push({
            domain: result.labels[i].replace('This is ', '').replace(' documentation', ''),
            confidence: result.scores[i],
          });
        }
      }

      // Sort by confidence
      classifications.sort((a, b) => b.confidence - a.confidence);

      this.cache.set(cacheKey, classifications);
      return classifications;
    } catch (error) {
      console.error('Error in domain classification:', error);
      return [];
    }
  }

  /**
   * Get a summary classification of the text
   */
  async classifyDocument(text) {
    const [technologies, domains] = await Promise.all([this.classifyTechnologies(text), this.classifyDomain(text)]);

    return {
      technologies,
      domains,
      primaryTechnology: technologies[0]?.technology || 'Unknown',
      primaryDomain: domains[0]?.domain || 'general',
    };
  }
}

// Export singleton instance
export const openClassifier = new OpenZeroShotClassifier();

// Export the class for testing
export default OpenZeroShotClassifier;
