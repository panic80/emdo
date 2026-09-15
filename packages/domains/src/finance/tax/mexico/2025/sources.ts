import {
  deepFreeze,
  FinanceTaxAuthorityReferenceSchema,
} from '@emdo/contracts';

const retrievedAt = '2026-09-14T05:05:20.000Z';

/**
 * Pinned primary-source captures used by the 2025 federal working-papers
 * candidate.  The checked-in files and hashes are also listed in
 * sources/capture-manifest.json; derived text extracts are never treated as
 * the authority document hash.
 */
export const MEXICO_2025_SOURCES = deepFreeze(
  [
    {
      id: 'inegi-mx-inpc-2025-01',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_02.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.043Z',
      documentHash:
        'cdcb01f603e5ac8010c96d70a9168211ad8b3a457d7e7ced807f46f803f3322a',
      locator: '2025 month 01 monthly INPC; first page',
      title: 'INPC 2025 month 01',
    },
    {
      id: 'inegi-mx-inpc-2025-02',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_03.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.043Z',
      documentHash:
        'fb68f11aaa575354627e11fad7db2efde5b85bb7a75acd50e086782eb23f452f',
      locator: '2025 month 02 monthly INPC; first page',
      title: 'INPC 2025 month 02',
    },
    {
      id: 'inegi-mx-inpc-2025-03',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_04.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.044Z',
      documentHash:
        '3ffbccae72534a841a41586a594c5f57cb729768fa71064617f797b895f336da',
      locator: '2025 month 03 monthly INPC; first page',
      title: 'INPC 2025 month 03',
    },
    {
      id: 'inegi-mx-inpc-2025-04',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_05.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.044Z',
      documentHash:
        '6361b4daa23d1eb8607c325eca9f7ff03ab202004844fceff9155d9167b2d28f',
      locator: '2025 month 04 monthly INPC; first page',
      title: 'INPC 2025 month 04',
    },
    {
      id: 'inegi-mx-inpc-2025-05',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_06.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.044Z',
      documentHash:
        'f28de16f55b3c8612a1ea3e644c9c368bfe95c985eaa2e8380e70c79a74fd78c',
      locator: '2025 month 05 monthly INPC; first page',
      title: 'INPC 2025 month 05',
    },
    {
      id: 'inegi-mx-inpc-2025-06',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_07.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.045Z',
      documentHash:
        '739c1fe8380e2db2b34566335645644990eece0440070c69a9d985139e9bd156',
      locator: '2025 month 06 monthly INPC; first page',
      title: 'INPC 2025 month 06',
    },
    {
      id: 'inegi-mx-inpc-2025-07',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_08.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.045Z',
      documentHash:
        'd6427bb0f7ba1e4800fbbd33f720d2273ab78904ffa77360b7f825d50a0069c2',
      locator: '2025 month 07 monthly INPC; first page',
      title: 'INPC 2025 month 07',
    },
    {
      id: 'inegi-mx-inpc-2025-08',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_09.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.046Z',
      documentHash:
        '65ce8ef588c4c5093c5ff0ec423850fed325090c9364456e650d30b8f7d8f261',
      locator: '2025 month 08 monthly INPC; first page',
      title: 'INPC 2025 month 08',
    },
    {
      id: 'inegi-mx-inpc-2025-09',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_10.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.046Z',
      documentHash:
        '8355747e2f3d0fb59f3a231ff01956f878607051a8ef5e85d62dd64e0deca77e',
      locator: '2025 month 09 monthly INPC; first page',
      title: 'INPC 2025 month 09',
    },
    {
      id: 'inegi-mx-inpc-2025-10',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_11.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.047Z',
      documentHash:
        'dcd12d1cf7a0f0ca45536bd7bfb3bedb8b016fe53491a2b59f9f3b64f3f51a9a',
      locator: '2025 month 10 monthly INPC; first page',
      title: 'INPC 2025 month 10',
    },
    {
      id: 'inegi-mx-inpc-2025-11',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_12.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:29:18.047Z',
      documentHash:
        'a9ab1e632544bff91935961618e24b93cc455471c219ad289b2c30076c73ed54',
      locator: '2025 month 11 monthly INPC; first page',
      title: 'INPC 2025 month 11',
    },
    {
      id: 'sat-mx-lisr-articulo-31',
      url: 'https://wwwmat.sat.gob.mx/articulo/42568/articulo-31',
      authority: 'Servicio de Administración Tributaria',
      retrievedAt: '2026-09-15T06:29:18.047Z',
      documentHash:
        '147528fcc749cbfd9293a2b2271e57e6630d7e036516a237a8977de42355d9de',
      locator: 'Article 31: investment deduction rules',
      title: 'Ley del ISR articulo 31',
    },
    {
      id: 'sat-mx-lisr-articulo-34',
      url: 'https://wwwmat.sat.gob.mx/articulo/61054/articulo-34',
      authority: 'Servicio de Administración Tributaria',
      retrievedAt: '2026-09-15T06:29:18.047Z',
      documentHash:
        '82272b23ea99fb59faf53f6f9be2685302559c75b0a3bea494833c2adfc2f56a',
      locator: 'Article 34: investment deduction rules',
      title: 'Ley del ISR articulo 34',
    },
    {
      id: 'inegi-mx-inpc-december-2024',
      url: 'https://en.www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/inpc/inpc_2q2025_01.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:06:55.335Z',
      documentHash:
        '76b296a4a424e143dff96197f1c3cb15e40fe56decd4fabd6fa29679abc317e4',
      locator: 'December 2024 monthly INPC 137.949',
      title: 'INPC December 2024',
    },
    {
      id: 'inegi-mx-inpc-december-2025',
      url: 'https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2026/inpc/inpc_2q2026_01.pdf',
      authority: 'INEGI',
      retrievedAt: '2026-09-15T06:06:56.026Z',
      documentHash:
        '2dcb2b6e9aca4f5c224b763ceeca37230742f6b60371e8b3efb51fa4dddcac80',
      locator: 'December 2025 monthly INPC 143.042',
      title: 'INPC December 2025',
    },
    {
      id: 'sat-mx-cff-articulo-17a',
      url: 'https://www.ordenjuridico.gob.mx/Documentos/Federal/html/wo56.html',
      authority: 'Secretaria de Gobernacion',
      retrievedAt: '2026-09-15T06:06:56.917Z',
      documentHash:
        '940b792579bc74394349c7246ebd59c5cd7a600e76b349e8e55d6c71e469592a',
      locator:
        'Article 17-A final paragraph; factors calculated to ten-thousandths',
      title: 'Codigo Fiscal de la Federacion Article 17-A',
    },
    {
      id: 'sat-mx-2025-declaracion-anual-personas',
      authority: 'Servicio de Administración Tributaria',
      title: 'Declaración Anual personas físicas 2025',
      url: 'https://www.sat.gob.mx/minisitio/DeclaracionAnual/Personas/quienes_deben_presentarla.html',
      locator:
        'Annual filing conditions; 2025 annual return available in April 2026',
      retrievedAt,
      documentHash:
        '2900e43ba7c8a940bc5e4ca4061bb4cc113004e56e91542f6342b264e3c168c3',
    },
    {
      id: 'sat-mx-2025-declaracion-anual-empresas',
      authority: 'Servicio de Administración Tributaria',
      title: 'Declaración Anual empresas 2025',
      url: 'https://www.sat.gob.mx/minisitio/DeclaracionAnual/Empresas/index.html',
      locator:
        'Régimen General annual return: exercise, ordinary regime, and 31 March 2026 filing deadline',
      retrievedAt,
      documentHash:
        '547d218c5bca24a8593240b548cc011b14482bd7c48a8a504fa4003ecf8a371c',
    },
    {
      id: 'sat-mx-2025-guia-personas-morales-regimen-general',
      authority: 'Servicio de Administración Tributaria',
      title:
        'Guía de llenado declaración anual personas morales Régimen General 2025',
      url: 'https://www.sat.gob.mx/minisitio/DeclaracionAnual/Empresas/documentos/GuiaLlenado_DelejercicioTerminacionAnticipada_regimengeneral.pdf',
      locator:
        'Régimen General guide sections 1-5: income, authorized deductions, determination, payment and additional data',
      retrievedAt,
      documentHash:
        'fdb9aa5d18233804949db7747865ce20e89652a2b01555d21565b038a4b6600e',
    },
    {
      id: 'sat-mx-2025-guia-sueldos-salarios',
      authority: 'Servicio de Administración Tributaria',
      title: 'Guía de llenado declaración anual sueldos y salarios 2025',
      url: 'https://www.sat.gob.mx/minisitio/DeclaracionAnual/Personas/documentos/GuiaLlenado_SueldosSalarios.pdf',
      locator:
        'Income annual/exempt/accumulated and subsidy fields; annual determination and balance',
      retrievedAt,
      documentHash:
        'de0f223b6dcbd991a1b31b8e6e4784b0ea34c9dcaf8305d6e31b5549f9f884dc',
    },
    {
      id: 'sat-mx-2025-guia-actividad-profesional',
      authority: 'Servicio de Administración Tributaria',
      title:
        'Guía de llenado declaración anual actividades empresariales y profesionales 2025',
      url: 'https://www.sat.gob.mx/minisitio/DeclaracionAnual/Personas/documentos/GuiaLlenado_ActividadesEmpresarialesProfesionales2025.pdf',
      locator:
        'Income, authorized deductions, fiscal result, provisional payments, retentions and annual determination',
      retrievedAt,
      documentHash:
        'ad5d24e886b96eb161db998ee9a6f762911af331b7a0a0d3e6d7066af070fa81',
    },
    {
      id: 'sat-mx-anexo8-rmf-2025',
      authority: 'Servicio de Administración Tributaria',
      title: 'Anexo 8 RMF 2025',
      url: 'https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2025/rmf/anexos/Anexo8_RMF2025-30122024.pdf',
      locator:
        'Section C(II): 2025 annual tariff for LISR articles 97 and 152; section V monthly employee tariff',
      retrievedAt,
      documentHash:
        '10c835248329b8dea58622aef24969345b39bff802fa3141ecda986218031751',
    },
    {
      id: 'sat-mx-lisr-articulo-90',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 90',
      url: 'https://wwwmat.sat.gob.mx/articulo/28342/articulo-90',
      locator: 'Individuals resident in Mexico subject to Title IV ISR',
      retrievedAt,
      documentHash:
        '4d22a61c5cfd604222967c6b2b003e03c0794e2b94e6d17efc0be45e239dfb43',
    },
    {
      id: 'sat-mx-lisr-articulo-9',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 9',
      url: 'https://wwwmat.sat.gob.mx/articulo/93578/articulo-9',
      locator:
        'Persons moral ordinary annual result: utility less PTU and losses, 30% rate and annual payment',
      retrievedAt,
      documentHash:
        '0aca24d161f2771476ada2f2a74ef9f50aaaa710f3c13264a8d57351057077cc',
    },
    {
      id: 'sat-mx-lisr-articulo-14',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 14',
      url: 'https://wwwmat.sat.gob.mx/articulo/36326/articulo-14',
      locator:
        'Monthly corporate provisional payments, utility coefficient and prior-payment credit',
      retrievedAt,
      documentHash:
        '03490a374c4bc092392ef241b7f4f1bf0ec75658e48ecc5263cf5a3049474cc0',
    },
    {
      id: 'sat-mx-lisr-articulo-25',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 25',
      url: 'https://wwwmat.sat.gob.mx/cs/Satellite?c=Articulo&childpagename=SatTyR%2FArticulo%2FSAT_LandingArticulo&cid=1462228824246&packedargs=d%3DTouch&pagename=TySWrapper',
      locator:
        'Corporate authorized-deduction categories: returns, cost of sales, expenses, investments, IMSS and interest',
      retrievedAt,
      documentHash:
        'e6bd273a85a421a85cfbcbe8d8e3759200c9a59c32a09a5c1432f13ec894a0bf',
    },
    {
      id: 'sat-mx-lisr-articulo-27',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 27',
      url: 'https://wwwmat.sat.gob.mx/articulo/05481/articulo-27',
      locator:
        'Corporate deduction requirements: indispensable, CFDI/payment, accounting and one-time deduction',
      retrievedAt,
      documentHash:
        'a846969c9bd7f925757174a3709532a0bc37f2005806f45fafd0ef80fbc63b71',
    },
    {
      id: 'sat-mx-lisr-articulo-44',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 44',
      url: 'https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461172533084&ssbinary=true',
      locator:
        'Articles 44-46: annual inflation adjustment from monthly credit/debt balances; classification definitions',
      retrievedAt,
      documentHash:
        'dba69d86c670dde380db5804a70aeb374b2259956913484105d0d2f53ce4f807',
    },
    {
      id: 'sat-mx-lisr-articulo-93',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 93',
      url: 'https://wwwmat.sat.gob.mx/articulo/15199/articulo-93',
      locator: 'Exempt-income categories and limitations',
      retrievedAt,
      documentHash:
        'dc71f1225674217cd5a4d315a89a960b77b274847a4cd3244e6597964825b96a',
    },
    {
      id: 'sat-mx-lisr-articulo-94',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 94',
      url: 'https://wwwmat.sat.gob.mx/articulo/91680/articulo-94',
      locator: 'Taxable salary and subordinated-service income definition',
      retrievedAt,
      documentHash:
        'dfb64ace02b0e136c0c106b1404306b16dca1ad337cb12e398a52d9513f0b966',
    },
    {
      id: 'sat-mx-lisr-articulo-96',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 96',
      url: 'https://wwwmat.sat.gob.mx/articulo/36534/articulo-96',
      locator:
        'Monthly salary withholding; local salary-tax deduction up to 5%',
      retrievedAt,
      documentHash:
        'f44cfd10428d3d66921bc323cc243d9d7795d75a8e44a38bf01a0d8629e8e724',
    },
    {
      id: 'sat-mx-lisr-articulo-97',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 97',
      url: 'https://wwwmat.sat.gob.mx/articulo/03635/articulo-97',
      locator:
        'Annual employer calculation; article 152 tariff and provisional-payment credit',
      retrievedAt,
      documentHash:
        'fe38b73c0155545487f24ac41ce8feb7f68127e162b63c1296f00707b11591b7',
    },
    {
      id: 'sat-mx-lisr-articulo-100',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 100',
      url: 'https://wwwmat.sat.gob.mx/articulo/18620/articulo-100',
      locator:
        'Business and independent professional-service income definitions',
      retrievedAt,
      documentHash:
        'c8d0ddbdc55043349f75bc23c31fcd6b89e7df3896d76654ee78d3df2734d7c5',
    },
    {
      id: 'sat-mx-lisr-articulo-102',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 102',
      url: 'https://wwwmat.sat.gob.mx/articulo/75346/articulo-102',
      locator:
        'Professional and business income accumulated when effectively received',
      retrievedAt,
      documentHash:
        '4d80609d33c0eb21c04c41ff47de2d826b6a805818f2e89aaca96eb7f148dfce',
    },
    {
      id: 'sat-mx-lisr-articulo-103',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 103',
      url: 'https://wwwmat.sat.gob.mx/articulo/37262/articulo-103',
      locator:
        'Authorized deductions I-VII, including local business/professional income tax',
      retrievedAt,
      documentHash:
        'd98e6153dc795d7403fd25fb4639d08791feacaf2c2b68d95d70280000ab68ec',
    },
    {
      id: 'sat-mx-lisr-articulo-105',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 105',
      url: 'https://wwwmat.sat.gob.mx/articulo/36596/articulo-105',
      locator: 'Requirements for professional and business deductions',
      retrievedAt,
      documentHash:
        '210308208883aaf1661f6c97dcae13a98ee0f7133103f18aeb18c537b75b6bb2',
    },
    {
      id: 'sat-mx-lisr-articulo-106',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 106',
      url: 'https://wwwmat.sat.gob.mx/articulo/36658/articulo-106',
      locator:
        'Monthly provisional payments and 10% professional-service withholding by legal entities',
      retrievedAt,
      documentHash:
        'f85ba979bdae98083d2fba70fc89f1b84c5f69ef424d43a89e56c54bd47995ca',
    },
    {
      id: 'sat-mx-lisr-articulo-109',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 109',
      url: 'https://wwwmat.sat.gob.mx/articulo/36723/articulo-109',
      locator:
        'Fiscal utility: income less authorized deductions, PTU paid and prior losses',
      retrievedAt,
      documentHash:
        'f438ec7bf3f278e8ccf9c717ba307e7dd5f455a10ba1ed552ef6c6cba44e264e',
    },
    {
      id: 'sat-mx-lisr-articulo-151',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 151',
      url: 'https://wwwmat.sat.gob.mx/articulo/82615/articulo-151',
      locator:
        'Personal deductions and general lesser-of-5-UMA-or-15%-of-total-income cap',
      retrievedAt,
      documentHash:
        'e8e6e54e51f9ad68130e4224f880f39c77cfcb0a7fb232b35a635455057d74a5',
    },
    {
      id: 'sat-mx-lisr-articulo-152',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 152',
      url: 'https://wwwmat.sat.gob.mx/articulo/36785/articulo-152',
      locator:
        'Annual calculation: Title IV income, business utility, personal deductions and credits',
      retrievedAt,
      documentHash:
        'e0eab888536b0d075b893edc84d5bbf0acc0b4fd817a9b9e33521da7a9b01734',
    },
    {
      id: 'sat-mx-lisr-articulo-76',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 76',
      url: 'https://wwwmatnp.sat.gob.mx/articulo/32449/articulo-76',
      locator:
        'Corporate accounting, financial-position statement, inventory and annual declaration obligations',
      retrievedAt,
      documentHash:
        '53335caea37af3f6a8d3abce59d8505a63b36eb01ce385a5eeca6b4a939e8c00',
    },
    {
      id: 'sat-mx-lisr-articulo-77',
      authority: 'Servicio de Administración Tributaria',
      title: 'Ley del ISR, artículo 77',
      url: 'https://wwwmat.sat.gob.mx/articulo/93973/articulo-77',
      locator:
        'Corporate CUFIN account and annual control; account schedule remains outside ordinary calculation',
      retrievedAt,
      documentHash:
        '252170dafbd5ca0290969209029a97d125ec4d668e178a1a7e62e2c2f1abd52e',
    },
    {
      id: 'sat-mx-2025-subsidio-empleo',
      authority: 'Servicio de Administración Tributaria',
      title: 'Employment subsidy decree effective 1 January 2025',
      url: 'https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461176401658&ssbinary=true',
      locator:
        '13.8% monthly UMA subsidy; January 2025 14.39% of 2024 monthly UMA; income threshold $10,171',
      retrievedAt,
      documentHash:
        '444a3b6e18dec7223216dfd99a00fc7fc69f00dc2ac846b9b931695aa34baa0f',
    },
    {
      id: 'dof-mx-2025-uma',
      authority:
        'Diario Oficial de la Federación / Instituto Nacional de Estadística y Geografía',
      title: '2025 Unidad de Medida y Actualización values',
      url: 'https://dof.gob.mx/nota_detalle.php?codigo=5746930&fecha=10/01/2025&print=true',
      locator:
        'Daily $113.14, monthly $3,439.46, annual $41,273.52; effective 1 February 2025',
      retrievedAt,
      documentHash:
        '50e1bbfafa7d5f8c465b95e29a18526f0a96fd2c5ef45a93a8a1dc16a2c5d229',
    },
  ].map((source) => FinanceTaxAuthorityReferenceSchema.parse(source)),
);

export const MX_2025_SOURCES = MEXICO_2025_SOURCES;
