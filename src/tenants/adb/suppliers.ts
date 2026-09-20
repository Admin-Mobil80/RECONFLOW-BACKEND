/**
 * Supplier master for the ADB proof of concept - the vendor master a
 * procurement system keeps. Seeded into the Procurement source as `supplier`
 * records, and the list the demonstration picks from. All fictional.
 */

export interface Supplier {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly country: string;
  readonly category: string;
}

export const SUPPLIERS: readonly Supplier[] = [
  { supplierId: "S-1001", supplierName: "Meridian Engineering Consultants", country: "Singapore", category: "Engineering" },
  { supplierId: "S-1002", supplierName: "Pacific Data Systems", country: "Australia", category: "IT services" },
  { supplierId: "S-1003", supplierName: "Anand Infrastructure Advisory", country: "India", category: "Advisory" },
  { supplierId: "S-1004", supplierName: "Luzon Survey Partners", country: "Philippines", category: "Surveying" },
  { supplierId: "S-1005", supplierName: "Mekong Logistics", country: "Viet Nam", category: "Logistics" },
  { supplierId: "S-1006", supplierName: "Indus Water Consultants", country: "Pakistan", category: "Water" },
  { supplierId: "S-1007", supplierName: "Northern Rail Consultants", country: "Kazakhstan", category: "Transport" },
  { supplierId: "S-1008", supplierName: "Sunda Energy Advisory", country: "Indonesia", category: "Energy" },
  { supplierId: "S-1009", supplierName: "Chao Phraya Urban Planning", country: "Thailand", category: "Urban" },
  { supplierId: "S-1010", supplierName: "Himalaya Hydro Services", country: "Nepal", category: "Energy" },
  { supplierId: "S-1011", supplierName: "Padma Agritech", country: "Bangladesh", category: "Agriculture" },
  { supplierId: "S-1012", supplierName: "Ceylon Port Engineering", country: "Sri Lanka", category: "Engineering" },
  { supplierId: "S-1013", supplierName: "Tonle Sap Environmental", country: "Cambodia", category: "Environment" },
  { supplierId: "S-1014", supplierName: "Irrawaddy Health Partners", country: "Myanmar", category: "Health" },
  { supplierId: "S-1015", supplierName: "Gobi Digital Learning", country: "Mongolia", category: "Education" },
  { supplierId: "S-1016", supplierName: "Ferghana Valley Irrigation", country: "Uzbekistan", category: "Water" },
  { supplierId: "S-1017", supplierName: "Malacca Strait Maritime", country: "Malaysia", category: "Transport" },
  { supplierId: "S-1018", supplierName: "Han River Fintech Advisory", country: "Republic of Korea", category: "Finance" },
  { supplierId: "S-1019", supplierName: "Kanto Climate Analytics", country: "Japan", category: "Climate" },
  { supplierId: "S-1020", supplierName: "Pearl River Smart Grid", country: "People's Republic of China", category: "Energy" },
];
