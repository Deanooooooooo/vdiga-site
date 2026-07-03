import { site } from "./site";

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: site.brand,
    legalName: site.legalName,
    url: site.url,
    address: {
      "@type": "PostalAddress",
      addressLocality: site.location,
      addressCountry: "BG",
    },
    description: site.descriptor,
  };
}

export function breadcrumbSchema(items: Array<{ name: string; href: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${site.url}${item.href}`,
    })),
  };
}

export function faqSchema(items: Array<{ question: string; answer: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

export function productSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Vdiga AI рецепционист",
    brand: {
      "@type": "Brand",
      name: site.brand,
    },
    description: site.descriptor,
    offers: site.pricing.map((tier) => ({
      "@type": "Offer",
      name: tier.name,
      price: tier.price.includes("-") ? tier.price.split("-")[0] : tier.price,
      priceCurrency: "EUR",
      availability: "https://schema.org/PreOrder",
      url: `${site.url}/tseni`,
    })),
  };
}

export function articleSchema(title: string, path: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    author: {
      "@type": "Person",
      name: site.author.name,
    },
    publisher: organizationSchema(),
    datePublished: "2026-07-03",
    dateModified: "2026-07-03",
    mainEntityOfPage: `${site.url}${path}`,
  };
}

