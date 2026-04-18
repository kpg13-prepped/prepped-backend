export type RecommendationInput = {
  adults?: number;
  babies?: number;
  children?: number;
  pets?: number;
  location_region?: string | null;
  housing_type?: string | null;
  vehicle_count?: number;
  storage_space?: string | null;
  food_depth?: string | null;
  water_depth?: string | null;
  blackout_ready?: boolean;
  first_aid_ready?: boolean;
  documents_ready?: boolean;
};

export function runRecommendation(profile: RecommendationInput) {
  const modules: string[] = [];
  const immediateActions: string[] = [];
  let baseline = "Preparation Pack";
  let confidence: "low" | "medium" | "high" = "medium";
  let stage = "Preparing";

  const householdSize =
    (profile.adults || 0) +
    (profile.babies || 0) +
    (profile.children || 0);

  if (householdSize >= 4) {
    modules.push("Family Expansion");
  }

  if (!profile.blackout_ready) {
    modules.push("Power and Lighting");
    immediateActions.push("Sort lighting and charging backup");
  }

  if (profile.water_depth !== "3+ days") {
    modules.push("Water Security");
    immediateActions.push("Increase household water coverage");
  }

  if ((profile.babies || 0) > 0) {
    modules.push("Baby Support");
  }

  if ((profile.pets || 0) > 0) {
    modules.push("Pet Care");
  }

  if ((profile.vehicle_count || 0) > 0) {
    modules.push("Vehicle Survival");
  }

  if (!profile.first_aid_ready) {
    immediateActions.push("Add or review first aid coverage");
  }

  if (!profile.documents_ready) {
    immediateActions.push("Organise key household documents");
  }

  if (
    profile.food_depth === "3+ days" &&
    profile.water_depth === "3+ days" &&
    profile.blackout_ready
  ) {
    stage = "Resourcing";
    confidence = "high";
  }

  return {
    baseline,
    modules: [...new Set(modules)].slice(0, 3),
    immediateActions: [...new Set(immediateActions)].slice(0, 3),
    stage,
    confidence,
    generatedAt: new Date().toISOString(),
  };
}
