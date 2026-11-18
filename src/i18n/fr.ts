import type { en } from './en.js'

/** Dictionnaire français : mêmes clés que en.ts */
export const fr = {
  // Coquille applicative
  appName: 'Console IA d’ingénierie',
  appTagline: 'Chef d’état-major cloud pour l’idéation, la diffusion des instructions et l’audit',
  welcomeTitle: 'Que construisons-nous aujourd’hui ?',
  welcomeLead:
    'D’abord un échange d’ingénierie sans détour. Une fois le plan solide, générez la consigne d’implémentation et la demande d’audit pour vos agents locaux.',
  welcomeHint: 'Agent 1 · console cloud. Aucun code ne s’exécute ici.',
  modeServer: 'Mode service local',
  modeServerHint:
    'Connecté au service local sur 127.0.0.1. Les clés API restent sur cette machine et ne sont jamais transmises à la page.',
  modeStatic: 'Mode statique direct',
  modeStaticHint:
    'Aucun service Python local détecté. Canaux et clés restent dans ce navigateur ; les requêtes partent directement vers vos points de terminaison.',
  storageRecovered:
    'Un fichier de configuration local endommagé a été récupéré depuis sa sauvegarde .bak.',
  storageMissing: 'Aucun fichier de configuration local ; les valeurs par défaut sont utilisées.',
  storageDegraded:
    'Avertissement de stockage : la migration des anciens en-têtes en clair vers secrets.json a échoué. Les valeurs d’origine sont conservées et la migration sera retentée ; vérifiez les droits d’écriture du répertoire de données.',
  serverStorageHint: 'Santé du stockage',
  serverOfflineBanner:
    'Service local injoignable. Lancez-le avec « python server.py », puis réessayez. Le mode statique direct n’est disponible que lorsque la page est ouverte depuis un fichier local (file://).',
  retryConnection: 'Réessayer la connexion',

  // Actions courantes
  newChat: 'Nouvelle conversation',
  untitledChat: 'Nouvelle conversation',
  chatHistory: 'Conversations',
  sessionDateToday: 'Aujourd’hui {time}',
  sessionDateYesterday: 'Hier {time}',
  deleteChat: 'Supprimer la conversation',
  deleteChatConfirm: 'Cette conversation sera supprimée définitivement. Continuer ?',
  delete: 'Supprimer',
  cancel: 'Annuler',
  confirm: 'Confirmer',
  close: 'Fermer',
  retry: 'Réessayer',
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  saved: 'Enregistré',
  copy: 'Copier',
  copied: 'Copié',
  copyFailed: 'Copie impossible. Sélectionnez le texte et copiez-le manuellement.',
  send: 'Envoyer',
  stop: 'Arrêter',
  settings: 'Paramètres',
  more: 'Plus',
  remove: 'Retirer',
  add: 'Ajouter',
  expand: 'Développer',
  collapse: 'Réduire',
  reset: 'Réinitialiser',
  loading: 'Chargement…',
  unknownError: 'Erreur inconnue',
  openSettings: 'Ouvrir les paramètres',
  configured: 'Configuré',
  notConfigured: 'Non configuré',

  // Barre supérieure / réinitialisation
  resetMenu: 'Réinitialisation',
  softReset: 'Réinitialisation douce',
  hardReset: 'Réinitialisation complète',
  softResetHint:
    'Coupe tous les flux et envois en attente, ferme les boîtes de dialogue bloquées et libère les verrous d’envoi. Conversations, brouillons et configuration sont conservés.',
  hardResetHint:
    'Efface la base locale du navigateur et le cache, puis recharge la page. Possibilité d’exporter d’abord un fichier texte de secours.',
  exportBeforeReset: 'Exporter un fichier texte de secours des conversations avant la réinitialisation',
  keepLocalKeys: 'Conserver les clés API stockées localement',
  hardResetConfirmTitle: 'Réinitialisation complète ?',
  hardResetConfirmText:
    'La base locale des conversations et le cache du navigateur seront effacés. Cette action est irréversible.',
  softResetDone: 'Les demandes en attente ont été arrêtées et l’interface débloquée.',
  exportDone: 'Fichier texte de secours exporté.',
  resetExportEmpty: 'Aucune conversation à exporter pour le moment.',
  resetBackupFailed:
    'Réinitialisation interrompue : la sauvegarde de secours est incomplète ou n’a pas pu être générée. Rien n’a été supprimé ; réessayez, ou décochez l’export avant réinitialisation pour vider la base malgré tout.',
  resetDatabaseBlocked:
    'La base du navigateur est encore ouverte dans un autre onglet. Fermez tous les autres onglets de cette console, puis réessayez.',
  resetDatabaseFailed:
    'Réinitialisation interrompue : la base du navigateur n’a pas pu être supprimée.',

  // Préférences
  language: 'Langue',
  theme: 'Thème',
  themeLight: 'Solarized clair',
  themeDark: 'Solarized sombre',
  themeSystem: 'Suivre le système',
  fontSize: 'Taille de police',
  fontScale90: '90 %',
  fontScale100: '100 %',
  fontScale112: '112 %',
  fontScale125: '125 %',
  contentWidth: 'Largeur du contenu',
  widthStandard: 'Standard 860 px',
  widthWide: 'Large 1120 px',
  reduceFlicker: 'Réduire le scintillement',
  reduceFlickerHint:
    'Désactive les pulsations en boucle, les points animés et les effets de balayage. Recommandé pour les longues sessions.',
  general: 'Général',
  channels: 'Canaux',
  prompts: 'Invites',
  advanced: 'Avancé',
  data: 'Données',
  settingsHint:
    'La plupart des réglages s’appliquent immédiatement. L’invite système et les modèles de capsules ne sont enregistrés qu’après avoir cliqué sur « Enregistrer » ou « Rétablir la valeur par défaut ».',
  collapseSidebar: 'Réduire la barre latérale',
  expandSidebar: 'Développer la barre latérale',

  // Canaux
  channelPrimary: 'Principal',
  channelBackup: 'Secours',
  switchChannel: 'Changer de canal',
  active: 'Actif',
  channelLabel: 'Libellé',
  protocol: 'Protocole',
  protocolOpenAi: 'Compatible OpenAI',
  protocolAnthropic: 'Anthropic Messages',
  baseUrl: 'URL de base',
  baseUrlPlaceholder: 'https://api.example.com/v1',
  apiKey: 'Clé API',
  apiKeyEnv: 'Variable d’environnement de la clé API',
  apiKeyHint:
    'Laissez vide pour les serveurs intranet sans clé (Ollama, vLLM, llama.cpp). Le nom de variable d’environnement facultatif des réglages avancés est lu en priorité (sa valeur n’est elle-même jamais écrite sur le disque ; laissez le champ de clé vide si vous n’avez pas besoin d’une clé de secours locale).',
  apiKeyMasked: 'Une clé est stockée ; seuls les quatre derniers caractères sont affichés.',
  apiKeyPlaceholder: 'Collez une nouvelle clé pour remplacer celle stockée',
  apiKeyPlaceholderStatic: 'Collez la clé utilisée pour les requêtes directes',
  apiKeyAutoSaveHint:
    'Enregistrée automatiquement lorsque le champ perd le focus ou que la fenêtre de réglages se ferme.',
  clearKey: 'Effacer la clé',
  model: 'Modèle',
  modelPlaceholder: 'model-id',
  thinkingModel: 'Modèle de réflexion (facultatif)',
  thinkingModelHint:
    'Utilisé lorsque l’interrupteur « Réflexion approfondie » est actif. Vide : le modèle normal est utilisé.',
  thinkingParamMode: 'Champs de requête pour la réflexion',
  thinkingParamNone: 'Aucun (par défaut, évite les erreurs 400)',
  thinkingParamAnthropic:
    'Anthropic : thinking avec budget_tokens (déduit des tokens de sortie)',
  thinkingParamDeepseek: 'thinking: {type: "enabled"}',
  thinkingParamReasoning: 'OpenAI : reasoning_effort "high"',
  thinkingParamEnable: 'enable_thinking: true',
  thinkingPassthroughHint:
    'Passthrough standard : ce canal n’ajoute aucun champ de réflexion à la requête. L’activer ne fait que basculer vers le modèle de réflexion configuré ; ajoutez un format de requête dans les réglages avancés si la passerelle l’exige.',
  thinkingBudgetHint:
    'Réflexion étendue Anthropic : budget_tokens {budget} ; max_tokens est relevé à au moins {maxTokens} et reste toujours supérieur au budget.',
  modalityMode: 'Politique de modalité',
  modalityAuto: 'Auto (repli en texte seul sur 400/415/422)',
  modalityTextOnly: 'Texte seulement (forcer le texte brut)',
  modalityMultimodal: 'Multimodal (images intégrées)',
  webSearchMode: 'Mode de recherche web',
  webSearchOff: 'Désactivée (interrupteur de recherche inactif)',
  webSearchExa: 'Récupération Exa (compatible avec tout modèle)',
  webSearchNative:
    'Outil web natif DeepSeek deepseek_web_search (uniquement passerelles compatibles Anthropic déclarant le prendre en charge)',
  remoteFileApi: 'Analyse documentaire distante (Anthropic Files API)',
  remoteFileApiHint:
    'Désactivée par défaut pour la confidentialité : les pièces jointes sont analysées localement. À activer uniquement si l’endpoint prend en charge Anthropic Files Beta et que l’analyse distante est acceptée. Seuls les PDF sont acceptés comme blocs document distants ; les anciens documents binaires (.doc/.xls/.ppt) et les fichiers audio sont refusés même avec cette option.',
  lockRawUrl: 'Verrouiller l’URL d’endpoint brute',
  lockRawUrlHint:
    'Utiliser l’URL de base exactement telle quelle, sans concaténation de chemin. Réservé aux passerelles d’entreprise particulières.',
  proxyMode: 'Politique de proxy',
  proxySystem: 'Suivre le proxy système',
  proxyDirect: 'Forcer la connexion directe (contourner le proxy)',
  proxyCustom: 'Proxy personnalisé',
  proxyUrl: 'URL du proxy personnalisé',
  allowInsecureTls:
    'Ignorer la vérification des certificats TLS (intranet de confiance uniquement)',
  customHeaders: 'En-têtes personnalisés',
  headerName: 'Nom de l’en-tête',
  headerValue: 'Valeur de l’en-tête',
  addHeader: 'Ajouter un en-tête',
  customHeadersMaskedHint:
    'Les valeurs d’en-tête enregistrées résident dans secrets.json et sont affichées masquées. Saisissez une nouvelle valeur pour la remplacer, laissez vide pour conserver la valeur stockée.',
  temperature: 'Température',
  maxTokens: 'Tokens de sortie maximum',
  requestTimeout: 'Délai d’expiration de la requête (secondes)',
  ping: 'Tester la connexion',
  pinging: 'Test en cours…',
  pingOk: 'Endpoint joignable.',
  pingOkNoModels: 'Endpoint joignable, mais aucune liste de modèles n’est exposée.',
  pingFail: 'Endpoint injoignable : {message}',
  probeModels: 'Récupérer les modèles',
  probing: 'Récupération…',
  modelsReceived: 'Modèles trouvés : {count}. Choisissez-en un ou continuez à saisir manuellement.',
  modelsEmpty: 'L’endpoint n’a pas renvoyé de liste de modèles. Saisissez l’ID du modèle manuellement.',
  urlPreview: 'URL finale de la requête',
  urlPreviewEmpty: 'Saisissez une URL de base pour afficher l’URL finale de la requête.',
  urlErrorEmpty: 'L’URL de base est vide.',
  urlErrorInvalid: 'L’URL de base n’est pas une URL http(s) valide.',
  urlErrorProtocol: 'Seuls les endpoints http:// et https:// sont autorisés.',
  urlErrorQuery:
    'La présence d’une chaîne de requête exige l’option « Verrouiller l’URL d’endpoint brute ».',
  urlLockedHint: 'URL brute verrouillée ; elle est envoyée exactement telle quelle.',
  emptyModelError: 'L’ID du modèle est vide.',
  saveFailed: 'Échec de l’enregistrement. Vérifiez le service local et réessayez.',
  saveFailedLocalStorage:
    'Échec de l’enregistrement : le stockage local du navigateur est plein ou bloqué. Libérez de l’espace et réessayez.',
  sessionReadFailed:
    'Échec du chargement : la conversation enregistrée n’a pas pu être lue depuis le stockage du navigateur. Réessayez.',
  deleteFailed:
    'Échec de la suppression : la conversation n’a pas été retirée et son brouillon est conservé. Réessayez.',
  deleteAllFailed:
    'Échec de la suppression de toutes les conversations : rien n’a été retiré et les brouillons sont conservés. Réessayez.',
  channelSaveFailed: 'La configuration du canal n’a pas pu être enregistrée.',
  exaEndpoint: 'Endpoint Exa',
  exaKey: 'Clé API Exa',
  exaKeyEnv: 'Variable d’environnement de la clé Exa',
  exaNumResults: 'Résultats de recherche par requête',
  exaMissingKey: 'Aucune clé API Exa configurée ; la recherche web est indisponible.',
  advancedSettings: 'Réglages avancés',
  advancedActiveCount: 'Options avancées actives : {count}',
  watchdogSection: 'Chiens de garde du flux',
  firstByteTimeout: 'Délai du premier octet (ms)',
  idleTimeout: 'Délai d’inactivité entre fragments (ms)',
  watchdogHint:
    'En cas de dépassement, la requête est interrompue, la sortie partielle conservée et des actions de relance sont proposées sous le message.',

  // Invites
  systemPrompt: 'Invite système (Agent 1)',
  systemPromptHint:
    'Maintenue identique à chaque tour pour préserver le cache KV de préfixe. Les capsules ne modifient jamais ce champ. Les modifications ne sont enregistrées qu’après « Enregistrer » ou « Rétablir la valeur par défaut ».',
  resetDefault: 'Rétablir la valeur par défaut',
  capsuleTemplates: 'Modèles des capsules d’action',
  capsuleTemplatesHint:
    'Ajoutés uniquement au prochain message sortant ; le texte du modèle injecté n’est jamais affiché dans les bulles de conversation. La langue du modèle suit celle de l’interface ; les modifications ne sont enregistrées qu’après « Enregistrer » ou « Rétablir la valeur par défaut ». {language} est remplacé à l’envoi : les modèles des Agents 2 et 3 utilisent la langue des consignes en aval, tandis que le modèle de synthèse du rapport suit toujours la langue de votre message courant.',
  capsuleTemplateRawHint:
    'Conservez {language} dans le modèle : pour les Agents 2 et 3, il est remplacé à l’envoi par la langue des consignes en aval ; pour la synthèse du rapport, il suit toujours la langue de votre message courant.',
  downstreamLanguage: 'Langue des consignes (Agents 2 et 3)',
  downstreamLanguageHint:
    'S’applique uniquement à l’espace réservé {language} des modèles de capsules des Agents 2 et 3 ; ce choix prend effet immédiatement. La capsule de synthèse du rapport suit toujours la langue de votre message.',
  languageFollow: 'Suivre la conversation en cours (par défaut)',
  promptLanguageFallback:
    'Les interfaces française et russe utilisent l’invite système anglaise par défaut ; modifiez-la librement ci-dessus.',
  savedDefault: 'Valeur par défaut intégrée en cours d’utilisation.',

  // Capsules
  capsuleBarLabel: 'Action unique pour ce message',
  capsuleAgent2: 'Générer l’instruction d’exécution (Agent 2)',
  capsuleAgent2Desc:
    'Rédige le plan validé sous forme d’une invite d’implémentation prête à copier pour l’exécuteur local sans état, avec périmètre strict et rapport d’anomalies obligatoire.',
  capsuleAgent3: 'Générer l’audit critique (Agent 3)',
  capsuleAgent3Desc:
    'Rédige une invite d’audit non directive et orientée falsification : cohérence d’ensemble, hypothèses cachées, défaillances temps réel et physiques, expériences requises, sur-conception.',
  capsuleDistill: 'Synthétiser le rapport',
  capsuleDistillDesc:
    'Transforme une erreur d’exécution ou un long rapport d’audit collé en une « fiche de décision feu tricolore » en trois points, en langage courant : peut-on livrer, ce qu’il faut vraiment corriger, quelles pinailles écarter.',
  capsuleActive: 'Appliqué au prochain message uniquement',
  capsuleInjectedNote: 'Valable pour ce message uniquement',
  capsuleTagAgent2: 'Instruction Agent 2',
  capsuleTagAgent3: 'Audit Agent 3',
  capsuleTagDistill: 'Synthèse du rapport',
  noSessions: 'Aucune conversation pour le moment',

  // Saisie
  inputPlaceholder: 'Décrivez le problème d’ingénierie ou collez le rapport à synthétiser…',
  attachFile: 'Joindre des fichiers',
  parsingFiles: 'Analyse locale des fichiers…',
  dropFiles: 'Déposez les fichiers à joindre',
  dropFilesHint:
    'Analyse déterministe locale. Jusqu’à {count} fichiers, {size} Mo chacun.',
  thinkingToggle: 'Réflexion approfondie',
  searchToggle: 'Recherche web',
  searchUnavailableOff:
    'La recherche web est désactivée pour ce canal (Paramètres → Canaux).',
  searchUnavailableNative:
    'La recherche native utilise l’outil serveur DeepSeek deepseek_web_search et ne fonctionne que sur les passerelles compatibles Anthropic qui déclarent le prendre en charge.',
  safetyNotice:
    'La sortie de l’IA ne constitue pas une certification de sécurité. Vérifiez chaque résultat ligne par ligne et par des essais réels avant tout contact avec le matériel.',
  attachmentBinaryUnsupported:
    'L’analyse déterministe locale est active. Pour éviter une déformation silencieuse des formules et de la mise en page, les PDF binaires ne sont pas lus directement, et les anciens documents binaires (.doc/.xls/.ppt) ainsi que les fichiers audio sont refusés même lorsque l’analyse distante est activée. Collez les paragraphes clés, joignez une capture d’écran, ou activez l’analyse documentaire distante uniquement pour les PDF.',
  attachmentTooLarge: 'Fichier trop volumineux (limite {size} Mo).',
  attachmentUnsupported: 'Type de fichier non pris en charge.',
  attachmentReadFailed: 'Le fichier n’a pas pu être lu.',
  attachmentOfficeFailed: 'La structure du document Office n’a pas pu être analysée.',
  attachmentOfficeTooLarge:
    'Le fichier Office dépasse le budget d’extraction locale de sécurité et n’a pas été analysé.',
  attachmentImageUnsupported:
    'Ce format d’image n’est pas pris en charge pour la vision intégrée. Utilisez PNG, JPEG, WebP ou GIF ; les fichiers SVG sont lus comme du texte.',
  attachmentTruncated: 'Tronqué pour protéger la fenêtre de contexte',
  attachmentRemote: 'Analyse distante',
  attachmentLocal: 'Analyse locale',
  attachmentCountLimit: 'Au plus {count} pièces jointes par message.',
  attachmentNeedsRemote:
    'Cette pièce jointe doit être analysée à distance ; activez d’abord l’analyse documentaire distante pour ce canal.',
  remoteFileStale:
    'Cette pièce jointe a été envoyée via un autre emplacement de canal, point de terminaison ou clé et n’a pas été transmise. Renvoyez-la pour le canal actif.',
  officeEmptySheet: '(feuille vide)',
  officeTruncatedRows:
    '[Tronqué : affichage des {rows} premières lignes non vides et de {columns} colonnes]',
  officeColumnsTruncated:
    '[Tronqué : toutes les cellules non vides dépassent la limite de 64 colonnes]',
  officeTruncatedDocument:
    '[Tronqué : le texte extrait du document atteint le budget de 256 Ko]',
  officeSlideHeading: '## Diapositive {index}',
  attachmentParseProgress: 'Analyse de {name}…',
  enterToSend: 'Entrée pour envoyer · Maj+Entrée pour un saut de ligne',
  stopGenerating: 'Arrêter la génération',
  configRequired: 'Configurez d’abord un canal (Paramètres → Canaux).',
  draftRestored: 'Brouillon non envoyé restauré',
  draftAttachmentLost: 'Texte du brouillon restauré ; les images n’ont pas pu être conservées après rechargement.',

  // Messages
  agent1Name: 'Agent 1',
  thoughtFor: 'Réflexion de {seconds} s',
  reasoningLabel: 'Raisonnement',
  showReasoning: 'Afficher le raisonnement',
  hideReasoning: 'Masquer le raisonnement',
  usageLabel: 'Tokens : {input} en entrée / {output} en sortie',
  compactAction: 'Compacter le contexte',
  compactTooltip:
    'Le texte complet reste lisible dans la conversation, mais un résumé court est envoyé au modèle dans les tours suivants.',
  compactDialogTitle: 'Compacter ce message',
  compactDialogHint:
    'Le modèle recevra ce résumé au lieu du texte complet dans les tours suivants. L’original reste dépliable dans la conversation.',
  compactAttachmentWarning:
    'Après compactage, le contexte ultérieur du modèle utilisera ce résumé à la place du texte original et du contenu des pièces jointes.',
  compactAttachmentIndex: 'Pièces jointes de ce message : {items}',
  compactBadge: 'Compacté',
  expandOriginal: 'Afficher l’original',
  hideOriginal: 'Masquer l’original',
  compactSummaryLabel: 'Résumé envoyé au modèle',
  compactSummaryPlaceholder: 'Résumé utilisé dans les tours suivants',
  compactDefaultMarker: '[Résumé compacté du message original]',
  rewind: 'Revenir à cette étape',
  rewindConfirmTitle: 'Remplacer le brouillon actuel ?',
  rewindConfirmText:
    'La zone de saisie contient déjà un brouillon non envoyé. Le retour arrière le remplacera.',
  rewindDone: 'Conversation tronquée ; le message a été replacé dans la zone de saisie.',
  retryRound: 'Relancer ce tour',
  retryTrimmed:
    'Les tours suivants ont été supprimés pour garder une chaîne de contexte cohérente ; relance à partir de ce tour.',
  retryOnBackup: 'Relancer sur le canal de secours',
  stoppedByUser: 'Arrêté par vous.',
  waitingFirstToken: 'En attente du premier token…',
  streamingLabel: 'Génération',
  messageActions: 'Actions du message',
  editMessage: 'Modifier et renvoyer',

  // Erreurs
  errorHttp: 'Requête rejetée par l’endpoint (HTTP {status}) : {message}',
  errorNetwork: 'Erreur réseau : {message}',
  errorWatchdogFirstByte: 'Aucun premier token en {seconds} s ; la requête a été interrompue.',
  errorWatchdogIdle: 'Aucune donnée pendant {seconds} s ; la requête a été interrompue.',
  errorProtocol: 'L’endpoint a renvoyé un format de flux inattendu : {message}',
  errorInvalidJson: 'Le point de terminaison a renvoyé un JSON invalide.',
  errorEmptyBody: 'Le point de terminaison a renvoyé un corps de réponse vide.',
  errorStream: 'L’endpoint a signalé une erreur de flux : {message}',
  errorInterrupted: 'Le flux s’est terminé avant la fin ; la réponse peut être tronquée.',
  errorAuth: 'Échec de l’authentification (HTTP {status}). Vérifiez la clé API de ce canal.',
  errorRateLimited: 'Trop de requêtes (HTTP 429). Patientez puis réessayez.',
  errorServerBusy:
    'Serveur amont surchargé (HTTP {status}). Réessayez ou basculez sur le canal de secours.',
  errorConfig: 'Configuration de la requête incomplète : {message}',
  errorPayloadTooLarge: 'La requête dépasse la limite de transfert de 32 Mo.',
  errorCrossOriginRedirect:
    'Le point de terminaison amont a tenté une redirection inter-origine. La requête a été bloquée pour protéger les identifiants.',
  errorInvalidExaEndpoint: 'Le point de terminaison Exa est invalide.',
  errorUpstreamStream: 'Le flux amont a signalé une erreur.',
  errorFileIdMissing:
    'La réponse de l’API de fichiers ne contient pas d’identifiant de fichier.',
  jsonBackupNotJson: 'Le fichier sélectionné n’est pas un JSON valide.',
  jsonBackupWrongSchema:
    'Le fichier sélectionné n’est pas une sauvegarde de sessions de la console.',
  jsonBackupUnsupportedVersion: 'Version de sauvegarde non prise en charge : {version}.',
  jsonBackupNoSessions: 'Le fichier de sauvegarde ne contient aucune liste de conversations.',
  jsonBackupMalformedSession:
    'La conversation {index} est mal formée ou contient un message invalide.',
  errorAborted: 'Requête interrompue.',
  errorImageOnly:
    'Le modèle actif n’accepte que le texte et ce message contient des images sans aucun texte. Votre brouillon et vos pièces jointes ont été conservés ; ajoutez du texte ou basculez vers un canal compatible vision.',
  imageOmittedToast:
    'Le modèle actif n’accepte pas les images. Le message a été rétrogradé automatiquement en texte brut.',
  searchFailedContinue:
    'La recherche web a échoué ; le message a été envoyé sans résultats de recherche.',
  searchEmpty: 'La recherche web n’a renvoyé aucun résultat exploitable.',

  // Données / réinitialisation
  exportSessions: 'Exporter les conversations en texte brut',
  exportHint: 'Fichier texte de secours. Les clés API ne sont jamais incluses.',
  exportSessionsJson: 'Exporter les conversations en JSON',
  exportJsonHint:
    'Sauvegarde JSON structurée avec l’arborescence complète des messages, le texte des pièces jointes et les données d’images. Les clés API ne sont jamais incluses.',
  importSessionsJson: 'Importer des conversations depuis un JSON',
  importJsonHint:
    'Validation stricte du schéma ; les clés API ne sont jamais lues. Les conversations existantes sont conservées.',
  exportJsonDone: 'Sauvegarde JSON exportée.',
  importJsonDone: '{sessions} conversations et {messages} messages importés.',
  importJsonInvalid: 'La sauvegarde JSON est invalide : {message}',
  importJsonFailed: 'Échec de l’import : {message}',
  importJsonEmpty: 'Aucune conversation exploitable dans le fichier sélectionné.',
  importJsonBusy: 'Importation…',
  importJsonTooLarge: 'Le fichier de sauvegarde sélectionné dépasse la limite d’importation de {size} Mo.',
  importJsonTooMany: 'La sauvegarde contient trop de conversations ou de messages pour un import sûr.',
  exportFieldGenerated: 'Généré : {time}',
  exportFieldSession: 'Session : {id}',
  exportFieldAttachments: 'Pièces jointes : {items}',
  exportFieldStatus: 'Statut : {status}',
  exportFieldUser: 'Utilisateur',
  exportFieldAgent: 'Agent 1',
  exportAttachmentBlock: '--- pièce jointe : {name} ({size} octets) ---',
  clearBrowserData: 'Effacer les données du navigateur',
  deleteAllChats: 'Supprimer toutes les conversations',
  deleteAllChatsConfirm:
    'Toutes les conversations et brouillons de ce navigateur seront supprimés. Continuer ?',
  exportPlainTextHeader: 'Console IA d’ingénierie — fichier texte de secours des conversations',

  // Markdown / Mermaid
  mermaidDiagram: 'Schéma',
  mermaidCode: 'Code',
  mermaidEmpty: 'Ce schéma est vide.',
  mermaidLoading: 'Rendu du schéma…',
  mermaidRenderFail: 'Le rendu Mermaid a échoué.',
  mermaidSwitchLabel: 'Basculer entre le schéma Mermaid et le code',

  // Divers
  download: 'Télécharger',
  fileSizeUnknown: 'Taille inconnue',
  scrollToBottom: 'Revenir en bas',
  charCount: 'Caractères : {count}',
  remoteEndpointKey: 'Endpoint d’analyse distante',
} satisfies Record<keyof typeof en, string>
