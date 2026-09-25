package demo;

import ai.confiqure.Confiqure;

/** Repricing rules for one listing. */
@Confiqure.List(end = "/listing-repricing")
public class ListingRepricing {
    @Confiqure.Identity
    private String listingSku;
    private Integer minPrice;
}
