import type { FinanceLocale } from './finance-document-api.js';

export type FinanceViewId = 'overview' | 'activity' | 'documents' | 'planning';

export type FinanceImportCopy = {
  readonly offline: string;
  readonly secureSessionRequired: string;
  readonly heading: string;
  readonly description: string;
  readonly open: string;
  readonly destinationsUnavailable: string;
  readonly invalidFile: string;
  readonly fileSize: string;
  readonly unreadableFile: string;
  readonly invalidCsvHeader: string;
  readonly incompleteMapping: string;
  readonly previewUnavailable: string;
  readonly deletionNotAuthorized: string;
  readonly importCommitted: string;
  readonly importAlreadyCommitted: string;
  readonly transactionsImported: string;
  readonly commitUnavailable: string;
  readonly commitRequested: string;
  readonly loadingDestinations: string;
  readonly noAccounts: string;
  readonly accountLabel: string;
  readonly chooseAccount: string;
  readonly defaultCategoryLabel: string;
  readonly noDefaultCategory: string;
  readonly statementFileLabel: string;
  readonly mappingLegend: string;
  readonly postedOnColumn: string;
  readonly descriptionColumn: string;
  readonly amountColumn: string;
  readonly debitColumn: string;
  readonly creditColumn: string;
  readonly externalIdColumn: string;
  readonly categoryColumn: string;
  readonly chooseColumn: string;
  readonly dateFormatLabel: string;
  readonly preview: string;
  readonly cancel: string;
  readonly reviewHeading: string;
  readonly accepted: string;
  readonly rejected: string;
  readonly duplicates: string;
  readonly row: string;
  readonly previewExpired: string;
  readonly reviewedLabel: string;
  readonly commit: string;
  readonly transactions: string;
};

export type FinanceCopy = {
  readonly views: Record<FinanceViewId, string>;
  readonly viewsAriaLabel: string;
  readonly title: string;
  readonly description: string;
  readonly financeUnavailable: string;
  readonly manualTransaction: string;
  readonly descriptionLabel: string;
  readonly categoryLabel: string;
  readonly amountLabel: string;
  readonly amountPlaceholder: string;
  readonly dateLabel: string;
  readonly saveTransaction: string;
  readonly cancel: string;
  readonly addTransaction: string;
  readonly recentTransactions: string;
  readonly recentTransactionsAriaLabel: string;
  readonly noTransactions: string;
  readonly transactionsLoading: string;
  readonly transactionsUnavailable: string;
  readonly loadMoreRecords: string;
  readonly budgets: string;
  readonly allocated: string;
  readonly noBudgets: string;
  readonly budgetsLoading: string;
  readonly budgetsUnavailable: string;
  readonly reviewedCadTotals: string;
  readonly noRecentActivity: string;
  readonly descriptionRequired: string;
  readonly descriptionTooLong: string;
  readonly categoryRequired: string;
  readonly categoryTooLong: string;
  readonly amountInvalid: string;
  readonly dateInvalid: string;
  readonly transactionSaveError: string;
  readonly documents: string;
  readonly addDocuments: string;
  readonly uploadHint: string;
  readonly uploadLimit: string;
  readonly noDocuments: string;
  readonly loadMoreDocuments: string;
  readonly uploadError: string;
  readonly uploadBusy: string;
  readonly openOriginal: string;
  readonly requestDeletion: string;
  readonly review: string;
  readonly retry: string;
  readonly commitReview: string;
  readonly matches: string;
  readonly evidence: string;
  readonly evidenceReferences: string;
  readonly evidencePage: string;
  readonly accept: string;
  readonly reject: string;
  readonly reviewPending: string;
  readonly reviewError: string;
  readonly matchError: string;
  readonly evidenceError: string;
  readonly reviewTotal: string;
  readonly dataControls: string;
  readonly dataControlsUrl: string;
  readonly documentType: string;
  readonly sourceLocale: string;
  readonly currency: string;
  readonly minorUnits: string;
  readonly paymentStatus: Readonly<{
    unpaid: string;
    paid: string;
    unknown: string;
  }>;
  readonly saveReview: string;
  readonly reviewCollectionHint: string;
  readonly reviewCollectionItem: string;
  readonly reviewCollectionRange: string;
  readonly reviewPreviousPage: string;
  readonly reviewNextPage: string;
  readonly reviewProposedRecordHint: string;
  readonly reviewJsonInvalid: string;
  readonly reviewFieldFallback: string;
  readonly actionRequested: string;
  readonly actionRequestError: string;
  readonly nonCad: string;
  readonly reviewedOnly: string;
  readonly recentActivity: string;
  readonly editTransaction: string;
  readonly categoryIdLabel: string;
  readonly annotationLabel: string;
  readonly saveTransactionEdit: string;
  readonly transactionEditRequested: string;
  readonly transactionEditError: string;
  readonly documentsUnavailable: string;
  readonly deletedDocument: string;
  readonly importPanel: FinanceImportCopy;
  readonly budgetEditor: string;
  readonly budgetMonthLabel: string;
  readonly budgetCategoryLabel: string;
  readonly budgetAllocationLabel: string;
  readonly saveBudget: string;
  readonly budgetMonthInvalid: string;
  readonly budgetCategoryInvalid: string;
  readonly budgetAllocationInvalid: string;
  readonly budgetSaveError: string;
};

export const financeCopy: Record<FinanceLocale, FinanceCopy> = {
  'en-CA': {
    views: {
      overview: 'Overview',
      activity: 'Activity',
      documents: 'Documents',
      planning: 'Planning',
    },
    viewsAriaLabel: 'Finance views',
    title: 'Finance',
    description:
      'Manual accounts and budgeting in CAD. No bank connections or payments.',
    financeUnavailable: 'Finance data is unavailable.',
    manualTransaction: 'Add manual transaction',
    descriptionLabel: 'Description',
    categoryLabel: 'Category',
    amountLabel: 'Amount (CAD)',
    amountPlaceholder: '0.00',
    dateLabel: 'Date',
    saveTransaction: 'Save transaction',
    cancel: 'Cancel',
    addTransaction: 'Add transaction',
    recentTransactions: 'Recent transactions',
    recentTransactionsAriaLabel: 'Recent manual transactions',
    noTransactions: 'No transactions have been saved yet.',
    transactionsLoading: 'Transaction data is loading…',
    transactionsUnavailable:
      'Transaction data is unavailable while encrypted storage is locked.',
    loadMoreRecords: 'Load more finance records',
    budgets: 'Budgets',
    allocated: 'allocated',
    noBudgets: 'No budgets have been saved yet.',
    budgetsLoading: 'Budget data is loading…',
    budgetsUnavailable:
      'Budget data is unavailable while encrypted storage is locked.',
    reviewedCadTotals: 'Reviewed CAD totals',
    noRecentActivity: 'No recent finance activity.',
    descriptionRequired: 'Enter a description.',
    descriptionTooLong: 'Description must be 160 characters or fewer.',
    categoryRequired: 'Enter a category.',
    categoryTooLong: 'Category must be 80 characters or fewer.',
    amountInvalid: 'Enter a CAD amount with up to two decimal places.',
    dateInvalid: 'Enter a valid date.',
    transactionSaveError:
      'The transaction could not be saved to encrypted offline data.',
    documents: 'Documents',
    addDocuments: 'Add documents',
    uploadHint: 'Choose PDFs, JPEGs, or PNGs.',
    uploadLimit:
      'Up to 20 files at once. Uploads are sent securely, up to 3 at a time.',
    noDocuments: 'No documents have been added yet.',
    loadMoreDocuments: 'Load more documents',
    uploadError:
      'Some documents could not be uploaded. Try again while online.',
    uploadBusy: 'Uploading documents…',
    openOriginal: 'Download original',
    requestDeletion: 'Ask EMDO to delete',
    review: 'Review extraction',
    retry: 'Retry extraction',
    commitReview: 'Commit reviewed document',
    matches: 'Review matches',
    evidence: 'Show evidence',
    evidenceReferences: 'Sources',
    evidencePage: 'Page',
    accept: 'Accept',
    reject: 'Reject',
    reviewPending:
      'This extraction is not yet reviewed. It is not included in totals or Ask EMDO evidence.',
    reviewError: 'The review could not be loaded. Try again while online.',
    matchError: 'Matches could not be loaded or updated.',
    evidenceError: 'Evidence could not be loaded.',
    reviewTotal: 'Extracted total',
    dataControls:
      'OpenAI does not use your data for training by default. Content may be retained in abuse-monitoring logs for up to 30 days.',
    dataControlsUrl: 'https://developers.openai.com/api/docs/guides/your-data',
    documentType: 'Document type',
    sourceLocale: 'Source language',
    currency: 'Currency',
    minorUnits: 'Minor units',
    paymentStatus: {
      unpaid: 'Unpaid',
      paid: 'Paid',
      unknown: 'Unknown',
    },
    saveReview: 'Save reviewed changes',
    reviewCollectionHint: 'Edit only the redacted items you need to correct.',
    reviewCollectionItem: 'Item',
    reviewCollectionRange: 'Items {start}–{end} of {total}',
    reviewPreviousPage: 'Previous',
    reviewNextPage: 'Next',
    reviewProposedRecordHint:
      'Edit the proposed record only when a reviewed correction is needed.',
    reviewJsonInvalid: 'Enter valid JSON before saving this review.',
    reviewFieldFallback: 'Additional review field',
    actionRequested: 'Your request was sent to EMDO for approval.',
    actionRequestError:
      'EMDO could not start this request. Try again while online.',
    nonCad: 'Items in currencies other than CAD are excluded from CAD totals.',
    reviewedOnly:
      'Only reviewed CAD information is included in totals and Ask EMDO evidence.',
    recentActivity: 'Recent activity',
    editTransaction: 'Categorize or annotate',
    categoryIdLabel: 'Category ID',
    annotationLabel: 'Annotation (optional)',
    saveTransactionEdit: 'Ask EMDO to save',
    transactionEditRequested: 'EMDO is handling this transaction update.',
    transactionEditError: 'EMDO could not start this transaction update.',
    documentsUnavailable: 'Documents are unavailable. Try again while online.',
    deletedDocument: 'Deleted document',
    importPanel: {
      offline: 'Statement import is available only while online.',
      secureSessionRequired: 'Statement import needs a current secure session.',
      heading: 'Import a statement',
      description:
        'CSV and OFX statements are reviewed online and are never queued for offline sync.',
      open: 'Import statement',
      destinationsUnavailable:
        'Import destinations are unavailable. Try again while online.',
      invalidFile: 'Choose a CSV or OFX statement file.',
      fileSize: 'Choose a non-empty statement smaller than 1 MB.',
      unreadableFile: 'EMDO could not read that statement file.',
      invalidCsvHeader:
        'Use a CSV with a valid header row of up to 50 named columns.',
      incompleteMapping:
        'Choose a date, description, and one signed amount or both debit and credit columns.',
      previewUnavailable:
        'EMDO could not preview that statement. Try again while online.',
      deletionNotAuthorized:
        'EMDO did not authorize deletion of the local statement.',
      importCommitted: 'Imported',
      importAlreadyCommitted: 'Import already committed:',
      transactionsImported: 'transactions.',
      commitUnavailable:
        'EMDO could not commit that import. The statement remains in memory for retry.',
      commitRequested:
        'EMDO received the reviewed import request. The statement remains in memory until completion is verified.',
      loadingDestinations: 'Loading import destinations…',
      noAccounts: 'Add an active finance account before importing a statement.',
      accountLabel: 'Import account',
      chooseAccount: 'Choose an account',
      defaultCategoryLabel: 'Default category (optional)',
      noDefaultCategory: 'No default category',
      statementFileLabel: 'Statement file',
      mappingLegend: 'CSV column mapping',
      postedOnColumn: 'Posted date column',
      descriptionColumn: 'Description column',
      amountColumn: 'Signed amount column',
      debitColumn: 'Debit column',
      creditColumn: 'Credit column',
      externalIdColumn: 'External ID column (optional)',
      categoryColumn: 'Category column (optional)',
      chooseColumn: 'Choose a column',
      dateFormatLabel: 'Date format',
      preview: 'Preview import',
      cancel: 'Cancel import',
      reviewHeading: 'Review import',
      accepted: 'accepted',
      rejected: 'rejected',
      duplicates: 'duplicates',
      row: 'Row',
      previewExpired:
        'This preview has expired. Create a new preview before committing.',
      reviewedLabel: 'I reviewed this import and want to commit it.',
      commit: 'Commit',
      transactions: 'transactions',
    },
    budgetEditor: 'Set monthly category budget',
    budgetMonthLabel: 'Month',
    budgetCategoryLabel: 'Category ID',
    budgetAllocationLabel: 'Allocation (CAD)',
    saveBudget: 'Save budget allocation',
    budgetMonthInvalid: 'Enter a month in YYYY-MM format.',
    budgetCategoryInvalid: 'Enter a lowercase category ID.',
    budgetAllocationInvalid:
      'Enter a non-negative CAD amount with up to two decimal places.',
    budgetSaveError:
      'The budget allocation could not be saved to encrypted offline data.',
  },
  'fr-CA': {
    views: {
      overview: 'Aperçu',
      activity: 'Activité',
      documents: 'Documents',
      planning: 'Planification',
    },
    viewsAriaLabel: 'Vues de finances',
    title: 'Finances',
    description:
      'Comptes et budget saisis manuellement en CAD. Aucune connexion bancaire ni aucun paiement.',
    financeUnavailable: 'Les données financières sont indisponibles.',
    manualTransaction: 'Ajouter une opération manuelle',
    descriptionLabel: 'Description',
    categoryLabel: 'Catégorie',
    amountLabel: 'Montant (CAD)',
    amountPlaceholder: '0.00',
    dateLabel: 'Date',
    saveTransaction: 'Enregistrer l’opération',
    cancel: 'Annuler',
    addTransaction: 'Ajouter une opération',
    recentTransactions: 'Opérations récentes',
    recentTransactionsAriaLabel: 'Opérations manuelles récentes',
    noTransactions: 'Aucune opération n’a encore été enregistrée.',
    transactionsLoading: 'Chargement des données d’opérations…',
    transactionsUnavailable:
      'Les données d’opérations sont indisponibles pendant que le stockage chiffré est verrouillé.',
    loadMoreRecords: 'Charger plus de données financières',
    budgets: 'Budgets',
    allocated: 'attribué',
    noBudgets: 'Aucun budget n’a encore été enregistré.',
    budgetsLoading: 'Chargement des données de budget…',
    budgetsUnavailable:
      'Les données de budget sont indisponibles pendant que le stockage chiffré est verrouillé.',
    reviewedCadTotals: 'Totaux CAD révisés',
    noRecentActivity: 'Aucune activité financière récente.',
    descriptionRequired: 'Saisissez une description.',
    descriptionTooLong: 'La description doit compter au plus 160 caractères.',
    categoryRequired: 'Saisissez une catégorie.',
    categoryTooLong: 'La catégorie doit compter au plus 80 caractères.',
    amountInvalid: 'Saisissez un montant en CAD avec au plus deux décimales.',
    dateInvalid: 'Saisissez une date valide.',
    transactionSaveError:
      'L’opération n’a pas pu être enregistrée dans les données hors ligne chiffrées.',
    documents: 'Documents',
    addDocuments: 'Ajouter des documents',
    uploadHint: 'Choisissez des fichiers PDF, JPEG ou PNG.',
    uploadLimit:
      'Jusqu’à 20 fichiers à la fois. Les envois sécurisés sont limités à 3 à la fois.',
    noDocuments: 'Aucun document n’a encore été ajouté.',
    loadMoreDocuments: 'Charger plus de documents',
    uploadError:
      'Certains documents n’ont pas pu être téléversés. Réessayez en ligne.',
    uploadBusy: 'Téléversement des documents…',
    openOriginal: 'Télécharger l’original',
    requestDeletion: 'Demander à EMDO de supprimer',
    review: 'Réviser l’extraction',
    retry: 'Réessayer l’extraction',
    commitReview: 'Valider le document révisé',
    matches: 'Réviser les correspondances',
    evidence: 'Afficher les sources',
    evidenceReferences: 'Sources',
    evidencePage: 'Page',
    accept: 'Accepter',
    reject: 'Rejeter',
    reviewPending:
      'Cette extraction n’est pas encore révisée. Elle n’est pas incluse dans les totaux ni les sources de Demander à EMDO.',
    reviewError: 'La révision n’a pas pu être chargée. Réessayez en ligne.',
    matchError:
      'Les correspondances n’ont pas pu être chargées ou mises à jour.',
    evidenceError: 'Les sources n’ont pas pu être chargées.',
    reviewTotal: 'Total extrait',
    dataControls:
      'OpenAI n’utilise pas vos données pour l’entraînement par défaut. Le contenu peut être conservé dans les journaux de surveillance des abus pendant un maximum de 30 jours.',
    dataControlsUrl: 'https://developers.openai.com/api/docs/guides/your-data',
    documentType: 'Type de document',
    sourceLocale: 'Langue source',
    currency: 'Devise',
    minorUnits: 'Unités mineures',
    paymentStatus: {
      unpaid: 'Impayée',
      paid: 'Payée',
      unknown: 'Inconnu',
    },
    saveReview: 'Enregistrer les corrections',
    reviewCollectionHint: 'Ne modifiez que les éléments expurgés à corriger.',
    reviewCollectionItem: 'Élément',
    reviewCollectionRange: 'Éléments {start}–{end} sur {total}',
    reviewPreviousPage: 'Précédent',
    reviewNextPage: 'Suivant',
    reviewProposedRecordHint:
      'Ne modifiez l’enregistrement proposé que si une correction révisée est nécessaire.',
    reviewJsonInvalid:
      'Saisissez du JSON valide avant d’enregistrer cette révision.',
    reviewFieldFallback: 'Champ de révision supplémentaire',
    actionRequested: 'Votre demande a été envoyée à EMDO pour approbation.',
    actionRequestError:
      'EMDO ne peut pas démarrer cette demande. Réessayez en ligne.',
    nonCad:
      'Les éléments dans une devise autre que le CAD sont exclus des totaux en CAD.',
    reviewedOnly:
      'Seules les informations CAD révisées sont incluses dans les totaux et les sources de Demander à EMDO.',
    recentActivity: 'Activité récente',
    editTransaction: 'Catégoriser ou annoter',
    categoryIdLabel: 'ID de catégorie',
    annotationLabel: 'Annotation (facultative)',
    saveTransactionEdit: 'Demander à EMDO d’enregistrer',
    transactionEditRequested: 'EMDO traite cette mise à jour de l’opération.',
    transactionEditError:
      'EMDO n’a pas pu démarrer cette mise à jour de l’opération.',
    documentsUnavailable:
      'Les documents sont indisponibles. Réessayez en ligne.',
    deletedDocument: 'Document supprimé',
    importPanel: {
      offline: 'L’importation de relevés est disponible uniquement en ligne.',
      secureSessionRequired:
        'L’importation de relevés exige une session sécurisée active.',
      heading: 'Importer un relevé',
      description:
        'Les relevés CSV et OFX sont révisés en ligne et ne sont jamais mis en file d’attente pour la synchronisation hors ligne.',
      open: 'Importer un relevé',
      destinationsUnavailable:
        'Les destinations d’importation sont indisponibles. Réessayez en ligne.',
      invalidFile: 'Choisissez un fichier de relevé CSV ou OFX.',
      fileSize: 'Choisissez un relevé non vide de moins de 1 Mo.',
      unreadableFile: 'EMDO n’a pas pu lire ce fichier de relevé.',
      invalidCsvHeader:
        'Utilisez un CSV avec une ligne d’en-tête valide comptant au plus 50 colonnes nommées.',
      incompleteMapping:
        'Choisissez une date, une description et un montant signé, ou les deux colonnes débit et crédit.',
      previewUnavailable:
        'EMDO n’a pas pu prévisualiser ce relevé. Réessayez en ligne.',
      deletionNotAuthorized:
        'EMDO n’a pas autorisé la suppression du relevé local.',
      importCommitted: 'Importation validée.',
      importAlreadyCommitted: 'L’importation a déjà été validée.',
      transactionsImported: 'opérations importées.',
      commitUnavailable:
        'EMDO n’a pas pu valider cette importation. Le relevé reste en mémoire pour une nouvelle tentative.',
      commitRequested:
        'EMDO a reçu la demande d’importation vérifiée. Le relevé reste en mémoire jusqu’à vérification de la fin.',
      loadingDestinations: 'Chargement des destinations d’importation…',
      noAccounts:
        'Ajoutez un compte financier actif avant d’importer un relevé.',
      accountLabel: 'Compte d’importation',
      chooseAccount: 'Choisissez un compte',
      defaultCategoryLabel: 'Catégorie par défaut (facultatif)',
      noDefaultCategory: 'Aucune catégorie par défaut',
      statementFileLabel: 'Fichier de relevé',
      mappingLegend: 'Correspondance des colonnes CSV',
      postedOnColumn: 'Colonne de date',
      descriptionColumn: 'Colonne de description',
      amountColumn: 'Colonne de montant signé',
      debitColumn: 'Colonne de débit',
      creditColumn: 'Colonne de crédit',
      externalIdColumn: 'Colonne d’ID externe (facultatif)',
      categoryColumn: 'Colonne de catégorie (facultatif)',
      chooseColumn: 'Choisissez une colonne',
      dateFormatLabel: 'Format de date',
      preview: 'Prévisualiser l’importation',
      cancel: 'Annuler l’importation',
      reviewHeading: 'Réviser l’importation',
      accepted: 'acceptées',
      rejected: 'rejetées',
      duplicates: 'doublons',
      row: 'Ligne',
      previewExpired:
        'Cette prévisualisation a expiré. Créez-en une nouvelle avant de valider.',
      reviewedLabel: 'J’ai révisé cette importation et je veux la valider.',
      commit: 'Valider',
      transactions: 'opérations',
    },
    budgetEditor: 'Définir le budget mensuel par catégorie',
    budgetMonthLabel: 'Mois',
    budgetCategoryLabel: 'ID de catégorie',
    budgetAllocationLabel: 'Allocation (CAD)',
    saveBudget: 'Enregistrer l’allocation budgétaire',
    budgetMonthInvalid: 'Saisissez un mois au format AAAA-MM.',
    budgetCategoryInvalid: 'Saisissez un ID de catégorie en minuscules.',
    budgetAllocationInvalid:
      'Saisissez un montant CAD non négatif avec au plus deux décimales.',
    budgetSaveError:
      'L’allocation budgétaire n’a pas pu être enregistrée dans les données hors ligne chiffrées.',
  },
  'ja-JP': {
    views: {
      overview: '概要',
      activity: 'アクティビティ',
      documents: '書類',
      planning: '計画',
    },
    viewsAriaLabel: 'ファイナンスの表示',
    title: 'ファイナンス',
    description:
      'CAD の手入力口座と予算管理です。銀行連携や支払いはありません。',
    financeUnavailable: 'ファイナンスデータを利用できません。',
    manualTransaction: '手入力の取引を追加',
    descriptionLabel: '説明',
    categoryLabel: 'カテゴリ',
    amountLabel: '金額（CAD）',
    amountPlaceholder: '0.00',
    dateLabel: '日付',
    saveTransaction: '取引を保存',
    cancel: 'キャンセル',
    addTransaction: '取引を追加',
    recentTransactions: '最近の取引',
    recentTransactionsAriaLabel: '最近の手入力取引',
    noTransactions: 'まだ保存された取引はありません。',
    transactionsLoading: '取引データを読み込んでいます…',
    transactionsUnavailable:
      '暗号化ストレージがロックされているため、取引データを利用できません。',
    loadMoreRecords: 'ファイナンス記録をさらに読み込む',
    budgets: '予算',
    allocated: '割り当て済み',
    noBudgets: 'まだ保存された予算はありません。',
    budgetsLoading: '予算データを読み込んでいます…',
    budgetsUnavailable:
      '暗号化ストレージがロックされているため、予算データを利用できません。',
    reviewedCadTotals: '確認済み CAD 合計',
    noRecentActivity: '最近のファイナンス活動はありません。',
    descriptionRequired: '説明を入力してください。',
    descriptionTooLong: '説明は160文字以内で入力してください。',
    categoryRequired: 'カテゴリを入力してください。',
    categoryTooLong: 'カテゴリは80文字以内で入力してください。',
    amountInvalid: '小数点以下2桁までの CAD 金額を入力してください。',
    dateInvalid: '有効な日付を入力してください。',
    transactionSaveError:
      '暗号化されたオフラインデータに取引を保存できませんでした。',
    documents: '書類',
    addDocuments: '書類を追加',
    uploadHint: 'PDF、JPEG、PNG を選択してください。',
    uploadLimit: '一度に最大20件。安全なアップロードは同時に最大3件です。',
    noDocuments: 'まだ書類は追加されていません。',
    loadMoreDocuments: '書類をさらに読み込む',
    uploadError:
      '一部の書類をアップロードできませんでした。オンラインで再試行してください。',
    uploadBusy: '書類をアップロードしています…',
    openOriginal: '元のファイルをダウンロード',
    requestDeletion: 'EMDO に削除を依頼',
    review: '抽出内容を確認',
    retry: '抽出を再試行',
    commitReview: '確認済み書類を確定',
    matches: '照合候補を確認',
    evidence: '根拠を表示',
    evidenceReferences: '根拠',
    evidencePage: 'ページ',
    accept: '承認',
    reject: '却下',
    reviewPending:
      'この抽出内容はまだ確認されていません。合計や Ask EMDO の根拠には含まれません。',
    reviewError:
      '確認内容を読み込めませんでした。オンラインで再試行してください。',
    matchError: '照合候補を読み込みまたは更新できませんでした。',
    evidenceError: '根拠を読み込めませんでした。',
    reviewTotal: '抽出合計',
    dataControls:
      'OpenAI はデフォルトでお客様のデータをトレーニングに使用しません。コンテンツは不正利用監視ログに最大30日間保持される場合があります。',
    dataControlsUrl: 'https://developers.openai.com/api/docs/guides/your-data',
    documentType: '書類の種類',
    sourceLocale: '元の言語',
    currency: '通貨',
    minorUnits: '最小通貨単位',
    paymentStatus: {
      unpaid: '未払い',
      paid: '支払い済み',
      unknown: '不明',
    },
    saveReview: '確認した変更を保存',
    reviewCollectionHint: '修正が必要な匿名化済み項目だけを編集してください。',
    reviewCollectionItem: '項目',
    reviewCollectionRange: '{total} 件中 {start}～{end} 件',
    reviewPreviousPage: '前へ',
    reviewNextPage: '次へ',
    reviewProposedRecordHint:
      '確認済みの修正が必要な場合にのみ、提案する記録を編集してください。',
    reviewJsonInvalid:
      'この確認を保存する前に、有効な JSON を入力してください。',
    reviewFieldFallback: '追加の確認項目',
    actionRequested: '承認のために EMDO へ依頼を送信しました。',
    actionRequestError:
      'EMDO はこの依頼を開始できませんでした。オンラインで再試行してください。',
    nonCad: 'CAD 以外の通貨の項目は CAD 合計から除外されます。',
    reviewedOnly:
      '確認済みの CAD 情報のみが合計と Ask EMDO の根拠に含まれます。',
    recentActivity: '最近のアクティビティ',
    editTransaction: 'カテゴリまたは注釈を編集',
    categoryIdLabel: 'カテゴリ ID',
    annotationLabel: '注釈（任意）',
    saveTransactionEdit: 'EMDO に保存を依頼',
    transactionEditRequested: 'EMDO がこの取引の更新を処理しています。',
    transactionEditError: 'EMDO はこの取引の更新を開始できませんでした。',
    documentsUnavailable:
      '書類を利用できません。オンラインで再試行してください。',
    deletedDocument: '削除済みの書類',
    importPanel: {
      offline: '明細のインポートはオンライン時のみ利用できます。',
      secureSessionRequired:
        '明細のインポートには有効な安全なセッションが必要です。',
      heading: '明細をインポート',
      description:
        'CSV と OFX の明細はオンラインで確認され、オフライン同期のキューには入れられません。',
      open: '明細をインポート',
      destinationsUnavailable:
        'インポート先を利用できません。オンラインで再試行してください。',
      invalidFile: 'CSV または OFX の明細ファイルを選択してください。',
      fileSize: '1 MB 未満の空でない明細を選択してください。',
      unreadableFile: 'EMDO はその明細ファイルを読み取れませんでした。',
      invalidCsvHeader:
        '最大50個の名前付き列を含む有効なヘッダー行の CSV を使用してください。',
      incompleteMapping:
        '日付、説明、符号付き金額1列、または借方と貸方の両方の列を選択してください。',
      previewUnavailable:
        'EMDO はその明細をプレビューできませんでした。オンラインで再試行してください。',
      deletionNotAuthorized: 'EMDO はローカル明細の削除を許可しませんでした。',
      importCommitted: 'インポートを確定しました。',
      importAlreadyCommitted: 'インポートはすでに確定されています。',
      transactionsImported: '件の取引をインポートしました。',
      commitUnavailable:
        'EMDO はそのインポートを確定できませんでした。明細は再試行用にメモリ内に保持されます。',
      commitRequested:
        'EMDO は確認済みインポートの依頼を受け取りました。完了が確認されるまで明細はメモリ内に保持されます。',
      loadingDestinations: 'インポート先を読み込んでいます…',
      noAccounts:
        '明細をインポートする前に有効なファイナンス口座を追加してください。',
      accountLabel: 'インポート口座',
      chooseAccount: '口座を選択',
      defaultCategoryLabel: '既定のカテゴリ（任意）',
      noDefaultCategory: '既定のカテゴリなし',
      statementFileLabel: '明細ファイル',
      mappingLegend: 'CSV 列の対応付け',
      postedOnColumn: '取引日列',
      descriptionColumn: '説明列',
      amountColumn: '符号付き金額列',
      debitColumn: '借方列',
      creditColumn: '貸方列',
      externalIdColumn: '外部 ID 列（任意）',
      categoryColumn: 'カテゴリ列（任意）',
      chooseColumn: '列を選択',
      dateFormatLabel: '日付形式',
      preview: 'インポートをプレビュー',
      cancel: 'インポートをキャンセル',
      reviewHeading: 'インポートを確認',
      accepted: '件を受理',
      rejected: '件を拒否',
      duplicates: '件の重複',
      row: '行',
      previewExpired:
        'このプレビューは期限切れです。確定する前に新しいプレビューを作成してください。',
      reviewedLabel: 'このインポートを確認し、確定します。',
      commit: '確定',
      transactions: '件の取引',
    },
    budgetEditor: '月ごとのカテゴリ予算を設定',
    budgetMonthLabel: '月',
    budgetCategoryLabel: 'カテゴリ ID',
    budgetAllocationLabel: '配分（CAD）',
    saveBudget: '予算配分を保存',
    budgetMonthInvalid: 'YYYY-MM 形式で月を入力してください。',
    budgetCategoryInvalid: '小文字のカテゴリ ID を入力してください。',
    budgetAllocationInvalid:
      '小数点以下2桁までの 0 以上の CAD 金額を入力してください。',
    budgetSaveError:
      '暗号化されたオフラインデータに予算配分を保存できませんでした。',
  },
  'ko-KR': {
    views: {
      overview: '개요',
      activity: '활동',
      documents: '문서',
      planning: '계획',
    },
    viewsAriaLabel: '금융 보기',
    title: '금융',
    description:
      'CAD 기준 수동 계정 및 예산 관리입니다. 은행 연결이나 결제는 없습니다.',
    financeUnavailable: '금융 데이터를 사용할 수 없습니다.',
    manualTransaction: '수동 거래 추가',
    descriptionLabel: '설명',
    categoryLabel: '카테고리',
    amountLabel: '금액(CAD)',
    amountPlaceholder: '0.00',
    dateLabel: '날짜',
    saveTransaction: '거래 저장',
    cancel: '취소',
    addTransaction: '거래 추가',
    recentTransactions: '최근 거래',
    recentTransactionsAriaLabel: '최근 수동 거래',
    noTransactions: '아직 저장된 거래가 없습니다.',
    transactionsLoading: '거래 데이터를 불러오는 중…',
    transactionsUnavailable:
      '암호화된 저장소가 잠겨 있어 거래 데이터를 사용할 수 없습니다.',
    loadMoreRecords: '금융 기록 더 불러오기',
    budgets: '예산',
    allocated: '배정됨',
    noBudgets: '아직 저장된 예산이 없습니다.',
    budgetsLoading: '예산 데이터를 불러오는 중…',
    budgetsUnavailable:
      '암호화된 저장소가 잠겨 있어 예산 데이터를 사용할 수 없습니다.',
    reviewedCadTotals: '검토된 CAD 합계',
    noRecentActivity: '최근 금융 활동이 없습니다.',
    descriptionRequired: '설명을 입력하세요.',
    descriptionTooLong: '설명은 160자 이하여야 합니다.',
    categoryRequired: '카테고리를 입력하세요.',
    categoryTooLong: '카테고리는 80자 이하여야 합니다.',
    amountInvalid: '소수점 이하 두 자리까지의 CAD 금액을 입력하세요.',
    dateInvalid: '유효한 날짜를 입력하세요.',
    transactionSaveError:
      '암호화된 오프라인 데이터에 거래를 저장하지 못했습니다.',
    documents: '문서',
    addDocuments: '문서 추가',
    uploadHint: 'PDF, JPEG 또는 PNG를 선택하세요.',
    uploadLimit: '한 번에 최대 20개 파일. 보안 업로드는 동시에 최대 3개입니다.',
    noDocuments: '아직 추가된 문서가 없습니다.',
    loadMoreDocuments: '문서 더 불러오기',
    uploadError:
      '일부 문서를 업로드하지 못했습니다. 온라인에서 다시 시도하세요.',
    uploadBusy: '문서를 업로드하는 중…',
    openOriginal: '원본 다운로드',
    requestDeletion: 'EMDO에 삭제 요청',
    review: '추출 검토',
    retry: '추출 다시 시도',
    commitReview: '검토한 문서 확정',
    matches: '일치 항목 검토',
    evidence: '근거 표시',
    evidenceReferences: '근거',
    evidencePage: '페이지',
    accept: '수락',
    reject: '거부',
    reviewPending:
      '이 추출 내용은 아직 검토되지 않았습니다. 합계나 Ask EMDO 근거에 포함되지 않습니다.',
    reviewError: '검토 내용을 불러오지 못했습니다. 온라인에서 다시 시도하세요.',
    matchError: '일치 항목을 불러오거나 업데이트하지 못했습니다.',
    evidenceError: '근거를 불러오지 못했습니다.',
    reviewTotal: '추출 합계',
    dataControls:
      'OpenAI는 기본적으로 데이터를 학습에 사용하지 않습니다. 콘텐츠는 악용 모니터링 로그에 최대 30일 동안 보관될 수 있습니다.',
    dataControlsUrl: 'https://developers.openai.com/api/docs/guides/your-data',
    documentType: '문서 유형',
    sourceLocale: '원본 언어',
    currency: '통화',
    minorUnits: '최소 통화 단위',
    paymentStatus: {
      unpaid: '미납',
      paid: '납부됨',
      unknown: '알 수 없음',
    },
    saveReview: '검토한 변경사항 저장',
    reviewCollectionHint: '수정할 익명화 항목만 편집하세요.',
    reviewCollectionItem: '항목',
    reviewCollectionRange: '{total}개 중 {start}–{end}개',
    reviewPreviousPage: '이전',
    reviewNextPage: '다음',
    reviewProposedRecordHint:
      '검토된 수정이 필요한 경우에만 제안된 기록을 편집하세요.',
    reviewJsonInvalid: '이 검토를 저장하기 전에 유효한 JSON을 입력하세요.',
    reviewFieldFallback: '추가 검토 필드',
    actionRequested: '승인을 위해 EMDO에 요청을 보냈습니다.',
    actionRequestError:
      'EMDO에서 이 요청을 시작하지 못했습니다. 온라인에서 다시 시도하세요.',
    nonCad: 'CAD 이외 통화 항목은 CAD 합계에서 제외됩니다.',
    reviewedOnly: '검토된 CAD 정보만 합계와 Ask EMDO 근거에 포함됩니다.',
    recentActivity: '최근 활동',
    editTransaction: '카테고리 또는 메모 편집',
    categoryIdLabel: '카테고리 ID',
    annotationLabel: '메모(선택 사항)',
    saveTransactionEdit: 'EMDO에 저장 요청',
    transactionEditRequested: 'EMDO가 이 거래 업데이트를 처리하고 있습니다.',
    transactionEditError: 'EMDO가 이 거래 업데이트를 시작하지 못했습니다.',
    documentsUnavailable:
      '문서를 사용할 수 없습니다. 온라인에서 다시 시도하세요.',
    deletedDocument: '삭제된 문서',
    importPanel: {
      offline: '명세서 가져오기는 온라인에서만 사용할 수 있습니다.',
      secureSessionRequired:
        '명세서 가져오기에는 현재의 보안 세션이 필요합니다.',
      heading: '명세서 가져오기',
      description:
        'CSV 및 OFX 명세서는 온라인에서 검토되며 오프라인 동기화 대기열에 추가되지 않습니다.',
      open: '명세서 가져오기',
      destinationsUnavailable:
        '가져오기 대상을 사용할 수 없습니다. 온라인에서 다시 시도하세요.',
      invalidFile: 'CSV 또는 OFX 명세서 파일을 선택하세요.',
      fileSize: '1MB보다 작은 비어 있지 않은 명세서를 선택하세요.',
      unreadableFile: 'EMDO에서 해당 명세서 파일을 읽을 수 없습니다.',
      invalidCsvHeader:
        '이름이 있는 열이 최대 50개인 유효한 헤더 행의 CSV를 사용하세요.',
      incompleteMapping:
        '날짜, 설명, 부호 있는 금액 열 하나 또는 차변과 대변 열 모두를 선택하세요.',
      previewUnavailable:
        'EMDO에서 해당 명세서를 미리 볼 수 없습니다. 온라인에서 다시 시도하세요.',
      deletionNotAuthorized: 'EMDO에서 로컬 명세서 삭제를 승인하지 않았습니다.',
      importCommitted: '가져오기를 확정했습니다.',
      importAlreadyCommitted: '가져오기가 이미 확정되었습니다.',
      transactionsImported: '건의 거래를 가져왔습니다.',
      commitUnavailable:
        'EMDO에서 해당 가져오기를 확정할 수 없습니다. 명세서는 재시도를 위해 메모리에 남아 있습니다.',
      commitRequested:
        'EMDO가 검토된 가져오기 요청을 받았습니다. 완료가 확인될 때까지 명세서는 메모리에 유지됩니다.',
      loadingDestinations: '가져오기 대상을 불러오는 중…',
      noAccounts: '명세서를 가져오기 전에 활성 금융 계정을 추가하세요.',
      accountLabel: '가져오기 계정',
      chooseAccount: '계정을 선택하세요',
      defaultCategoryLabel: '기본 카테고리(선택 사항)',
      noDefaultCategory: '기본 카테고리 없음',
      statementFileLabel: '명세서 파일',
      mappingLegend: 'CSV 열 매핑',
      postedOnColumn: '거래일 열',
      descriptionColumn: '설명 열',
      amountColumn: '부호 있는 금액 열',
      debitColumn: '차변 열',
      creditColumn: '대변 열',
      externalIdColumn: '외부 ID 열(선택 사항)',
      categoryColumn: '카테고리 열(선택 사항)',
      chooseColumn: '열을 선택하세요',
      dateFormatLabel: '날짜 형식',
      preview: '가져오기 미리 보기',
      cancel: '가져오기 취소',
      reviewHeading: '가져오기 검토',
      accepted: '건 수락',
      rejected: '건 거부',
      duplicates: '건 중복',
      row: '행',
      previewExpired:
        '이 미리 보기는 만료되었습니다. 확정 전에 새 미리 보기를 만드세요.',
      reviewedLabel: '이 가져오기를 검토했으며 확정합니다.',
      commit: '확정',
      transactions: '건의 거래',
    },
    budgetEditor: '월별 카테고리 예산 설정',
    budgetMonthLabel: '월',
    budgetCategoryLabel: '카테고리 ID',
    budgetAllocationLabel: '배정(CAD)',
    saveBudget: '예산 배정 저장',
    budgetMonthInvalid: 'YYYY-MM 형식으로 월을 입력하세요.',
    budgetCategoryInvalid: '소문자 카테고리 ID를 입력하세요.',
    budgetAllocationInvalid:
      '소수점 이하 두 자리까지의 0 이상 CAD 금액을 입력하세요.',
    budgetSaveError:
      '암호화된 오프라인 데이터에 예산 배정을 저장하지 못했습니다.',
  },
};

const financeReviewLabels: Record<
  FinanceLocale,
  Readonly<Record<string, string>>
> = {
  'en-CA': {
    issuer: 'Issuer',
    recipient: 'Recipient',
    merchant: 'Merchant',
    vendor: 'Vendor',
    invoiceNumber: 'Invoice number',
    paymentStatus: 'Payment status',
    institution: 'Financial institution',
    employer: 'Employer',
    provider: 'Provider',
    policyType: 'Policy type',
    lender: 'Lender',
    loanType: 'Loan type',
    slipType: 'Slip type',
    summary: 'Summary',
    accountLast4: 'Account ending',
    paymentMethodLast4: 'Payment method ending',
    policyLast4: 'Policy ending',
    issuedOn: 'Issue date',
    dueOn: 'Due date',
    periodStart: 'Period start',
    periodEnd: 'Period end',
    purchasedOn: 'Purchase date',
    taxYear: 'Tax year',
    annualRateBasisPoints: 'Annual rate (basis points)',
    subtotal: 'Subtotal',
    tax: 'Tax',
    total: 'Total',
    tip: 'Tip',
    openingBalance: 'Opening balance',
    closingBalance: 'Closing balance',
    minimumPayment: 'Minimum payment',
    grossPay: 'Gross pay',
    deductions: 'Deductions',
    netPay: 'Net pay',
    premium: 'Premium',
    balance: 'Balance',
    marketValue: 'Market value',
    proposedRecord: 'Proposed record',
    facts: 'Extracted facts',
    lineItems: 'Line items',
    transactions: 'Transactions',
    boxes: 'Tax slip boxes',
    holdings: 'Holdings',
  },
  'fr-CA': {
    issuer: 'Émetteur',
    recipient: 'Destinataire',
    merchant: 'Marchand',
    vendor: 'Fournisseur',
    invoiceNumber: 'Numéro de facture',
    paymentStatus: 'État du paiement',
    institution: 'Institution financière',
    employer: 'Employeur',
    provider: 'Fournisseur',
    policyType: 'Type de police',
    lender: 'Prêteur',
    loanType: 'Type de prêt',
    slipType: 'Type de feuillet',
    summary: 'Résumé',
    accountLast4: 'Compte se terminant par',
    paymentMethodLast4: 'Mode de paiement se terminant par',
    policyLast4: 'Police se terminant par',
    issuedOn: 'Date d’émission',
    dueOn: 'Date d’échéance',
    periodStart: 'Début de période',
    periodEnd: 'Fin de période',
    purchasedOn: 'Date d’achat',
    taxYear: 'Année fiscale',
    annualRateBasisPoints: 'Taux annuel (points de base)',
    subtotal: 'Sous-total',
    tax: 'Taxe',
    total: 'Total',
    tip: 'Pourboire',
    openingBalance: 'Solde d’ouverture',
    closingBalance: 'Solde de clôture',
    minimumPayment: 'Paiement minimum',
    grossPay: 'Salaire brut',
    deductions: 'Retenues',
    netPay: 'Salaire net',
    premium: 'Prime',
    balance: 'Solde',
    marketValue: 'Valeur marchande',
    proposedRecord: 'Enregistrement proposé',
    facts: 'Faits extraits',
    lineItems: 'Articles',
    transactions: 'Opérations',
    boxes: 'Cases du feuillet',
    holdings: 'Placements',
  },
  'ja-JP': {
    issuer: '発行者',
    recipient: '受取人',
    merchant: '加盟店',
    vendor: '取引先',
    invoiceNumber: '請求書番号',
    paymentStatus: '支払い状況',
    institution: '金融機関',
    employer: '雇用主',
    provider: '提供者',
    policyType: '保険種類',
    lender: '貸し手',
    loanType: 'ローンの種類',
    slipType: '票の種類',
    summary: '概要',
    accountLast4: '口座末尾',
    paymentMethodLast4: '支払方法末尾',
    policyLast4: '保険証券末尾',
    issuedOn: '発行日',
    dueOn: '支払期日',
    periodStart: '対象期間開始',
    periodEnd: '対象期間終了',
    purchasedOn: '購入日',
    taxYear: '課税年度',
    annualRateBasisPoints: '年利（ベーシスポイント）',
    subtotal: '小計',
    tax: '税額',
    total: '合計',
    tip: 'チップ',
    openingBalance: '開始残高',
    closingBalance: '終了残高',
    minimumPayment: '最低支払額',
    grossPay: '総支給額',
    deductions: '控除額',
    netPay: '手取り額',
    premium: '保険料',
    balance: '残高',
    marketValue: '時価',
    proposedRecord: '提案する記録',
    facts: '抽出された項目',
    lineItems: '明細',
    transactions: '取引',
    boxes: '税務票のボックス',
    holdings: '保有銘柄',
  },
  'ko-KR': {
    issuer: '발급기관',
    recipient: '수취인',
    merchant: '가맹점',
    vendor: '공급업체',
    invoiceNumber: '청구서 번호',
    paymentStatus: '결제 상태',
    institution: '금융기관',
    employer: '고용주',
    provider: '제공업체',
    policyType: '보험 유형',
    lender: '대출기관',
    loanType: '대출 유형',
    slipType: '명세서 유형',
    summary: '요약',
    accountLast4: '계좌 끝번호',
    paymentMethodLast4: '결제 수단 끝번호',
    policyLast4: '보험증권 끝번호',
    issuedOn: '발행일',
    dueOn: '납부일',
    periodStart: '기간 시작',
    periodEnd: '기간 종료',
    purchasedOn: '구매일',
    taxYear: '과세연도',
    annualRateBasisPoints: '연이율(베이시스 포인트)',
    subtotal: '소계',
    tax: '세금',
    total: '합계',
    tip: '팁',
    openingBalance: '기초 잔액',
    closingBalance: '기말 잔액',
    minimumPayment: '최소 납부액',
    grossPay: '총급여',
    deductions: '공제',
    netPay: '순급여',
    premium: '보험료',
    balance: '잔액',
    marketValue: '시장 가치',
    proposedRecord: '제안된 기록',
    facts: '추출된 항목',
    lineItems: '항목',
    transactions: '거래',
    boxes: '세금 서류 상자',
    holdings: '보유 종목',
  },
};

export function financeReviewLabel(
  locale: FinanceLocale,
  field: string,
): string {
  const copy = financeCopy[locale] ?? financeCopy['en-CA'];
  return financeReviewLabels[locale]?.[field] ?? copy.reviewFieldFallback;
}

export function browserFinanceLocale(): FinanceLocale {
  const browser =
    typeof navigator === 'undefined' ? undefined : navigator.language;
  return browser && browser in financeCopy
    ? (browser as FinanceLocale)
    : 'en-CA';
}
