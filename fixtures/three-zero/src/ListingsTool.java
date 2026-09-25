package demo;

import ai.confiqure.Confiqure;
import java.util.List;
import org.springframework.web.bind.annotation.*;

/** FLOW: find the listing by title, then open it. */
@Confiqure.Tool(name = "ListingsTool")
@RestController
@RequestMapping("/api/confiqure/listings")
public class ListingsTool {
    /** Listings whose title contains the words. */
    @PostMapping("/by-title")
    public List<Listing> byTitle(@RequestBody TitleQuery q) { return null; }
}
